import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * MCP 的跨组织隔离 —— 这条链路上**没有第二道网**。
 *
 * 浏览器那条路上,应用层写错了查询范围,RLS 还会在数据库层挡住。
 * 这条路上不一样:令牌不是 Supabase 的 JWT,拿不到用户会话,所以全部走
 * service_role —— 而它绕过 RLS。也就是说每个查询里那句
 * `.eq("organization_id", organizationId)` 就是**唯一防线**,
 * 漏一处就是跨组织数据泄露,而且不会有任何报错。
 *
 * 所以这里同时用两种方式钉它:
 *   1. 行为断言:拿 A 组织的令牌去读写 B 组织的工作区必须失败
 *   2. 源码断言:每一处数据库查询都必须带上组织收窄
 * 第二条看着笨,但它能挡住「以后新加一个工具时忘了写」——
 * 而那正是这类泄露最常见的成因。
 */

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKSPACE_OF_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * 一个只认「组织 + 主键」的假数据库。
 *
 * 它严格模拟 service_role 的行为:**不做任何隐式过滤**。
 * 查询要什么就给什么,组织收窄完全靠调用方自己写 ——
 * 这正是真实情况,也正是危险所在。
 */
function fakeAdmin(rows: Record<string, Record<string, unknown>[]>) {
  const calls: { table: string; filters: Record<string, unknown> }[] = [];

  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    const api: Record<string, unknown> = {
      select: () => api,
      order: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      maybeSingle: async () => {
        calls.push({ table, filters });
        const hit = (rows[table] ?? []).find((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return { data: hit ?? null, error: null };
      },
      then: (resolveFn: (v: unknown) => unknown) => {
        calls.push({ table, filters });
        const hits = (rows[table] ?? []).filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return Promise.resolve({ data: hits, error: null }).then(resolveFn);
      },
      upsert: async (row: Record<string, unknown>) => {
        calls.push({ table, filters: row });
        (rows[table] ??= []).push(row);
        return { error: null };
      },
    };
    return api;
  };

  return { admin: { from: (t: string) => builder(t) }, calls };
}

async function loadTools(rows: Record<string, Record<string, unknown>[]>) {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  const fake = fakeAdmin(rows);
  vi.doMock("@/lib/supabase/admin", () => ({
    createSupabaseAdminClient: () => fake.admin,
    hasAdminAccess: () => true,
  }));
  const mod = await import("@/lib/mcp/tools");
  return { ...mod, calls: fake.calls };
}

/** B 组织有一个工作区和一个文件;A 组织什么都没有 */
const seed = () => ({
  organizations: [{ id: ORG_B, name: "B 公司", slug: "b-co" }],
  workspaces: [
    { id: WORKSPACE_OF_B, organization_id: ORG_B, name: "B 的项目", created_at: "x" },
  ],
  workspace_files: [
    {
      workspace_id: WORKSPACE_OF_B,
      organization_id: ORG_B,
      path: "secret.ts",
      content: "B 组织的机密源码",
      size_chars: 8,
    },
  ],
});

describe("拿 A 组织的令牌,碰不到 B 组织的数据", () => {
  it("列工作区:只能看到自己组织的", async () => {
    const { executeMcpTool } = await loadTools(seed());

    // 正向对照:B 看得到自己的工作区
    const own = await executeMcpTool("zhiyi_workspace_list", {}, ORG_B);
    expect(own.text, `正向对照失败:${own.text}`).toContain("B 的项目");

    const r = await executeMcpTool("zhiyi_workspace_list", {}, ORG_A);
    expect(r.text).not.toContain("B 的项目");
    expect(r.text).not.toContain(WORKSPACE_OF_B);
  });

  it("指名道姓地列 B 的工作区,也拿不到", async () => {
    const { executeMcpTool } = await loadTools(seed());
    const r = await executeMcpTool(
      "zhiyi_workspace_list",
      { workspaceId: WORKSPACE_OF_B },
      ORG_A,
    );
    expect(r.text).not.toContain("B 的项目");
  });

  it("读 B 的文件:读不到内容", async () => {
    const { executeMcpTool } = await loadTools(seed());

    // 正向对照:B 自己必须读得到。
    // 没有这一条,上面那句 not.toContain 会在**任何**失败路径上都通过 ——
    // 参数校验没过、mock 没生效、工具名写错,统统算「安全」。
    // 这套测试第一版就是这么假绿的:UUID 写得不合法,每次都返回
    // 「参数不合法」,而断言只问「有没有机密二字」,自然永远没有。
    const own = await executeMcpTool(
      "zhiyi_workspace_read",
      { workspaceId: WORKSPACE_OF_B, path: "secret.ts" },
      ORG_B,
    );
    expect(own.isError, `正向对照失败,说明测试环境没搭对:${own.text}`).toBe(false);
    expect(own.text).toContain("机密");

    const r = await executeMcpTool(
      "zhiyi_workspace_read",
      { workspaceId: WORKSPACE_OF_B, path: "secret.ts" },
      ORG_A,
    );
    expect(r.text).not.toContain("机密");
  });

  it("写进 B 的工作区:必须被拒,而且**一个字节都不能落库**", async () => {
    const rows = seed();
    const { executeMcpTool } = await loadTools(rows);

    // 正向对照:B 自己写得进去。这条一旦失败,下面那句「没落库」
    // 就毫无意义 —— 因为可能谁都写不进去
    const own = await executeMcpTool(
      "zhiyi_workspace_write",
      { workspaceId: WORKSPACE_OF_B, path: "ok.ts", content: "正常写入" },
      ORG_B,
    );
    expect(own.isError, `正向对照失败:${own.text}`).toBe(false);
    expect(rows.workspace_files.some((f) => f["path"] === "ok.ts")).toBe(true);

    const r = await executeMcpTool(
      "zhiyi_workspace_write",
      { workspaceId: WORKSPACE_OF_B, path: "植入.ts", content: "恶意内容" },
      ORG_A,
    );
    expect(r.isError).toBe(true);
    // 归属校验必须在写之前。少了它,upsert 按 (workspace_id, path) 冲突,
    // organization_id 只是跟着写进去的一个字段,不构成任何约束
    expect(rows.workspace_files.some((f) => f["path"] === "植入.ts")).toBe(false);
  });

  it("whoami 只认令牌里的组织,不接受参数覆盖", async () => {
    const { executeMcpTool } = await loadTools(seed());

    // 正向对照:B 拿得到自己的组织名
    const own = await executeMcpTool("zhiyi_whoami", {}, ORG_B);
    expect(own.text, `正向对照失败:${own.text}`).toContain("B 公司");

    const r = await executeMcpTool(
      "zhiyi_whoami",
      { organizationId: ORG_B } as never,
      ORG_A,
    );
    expect(r.text).not.toContain("B 公司");
  });
});

describe("每一次数据库访问都带着组织收窄", () => {
  it("所有查询的过滤条件里都有 organization_id", async () => {
    const { executeMcpTool, calls } = await loadTools(seed());
    // 把每个工具都跑一遍,再检查它们碰过的每一次查询
    await executeMcpTool("zhiyi_whoami", {}, ORG_A);
    await executeMcpTool("zhiyi_workspace_list", {}, ORG_A);
    await executeMcpTool(
      "zhiyi_workspace_read",
      { workspaceId: WORKSPACE_OF_B, path: "secret.ts" },
      ORG_A,
    );
    await executeMcpTool(
      "zhiyi_workspace_write",
      { workspaceId: WORKSPACE_OF_B, path: "a.ts", content: "x" },
      ORG_A,
    );

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const scoped =
        "organization_id" in c.filters ||
        // organizations 表本身用主键 id 收窄,等价
        (c.table === "organizations" && "id" in c.filters);
      expect(scoped, `${c.table} 的查询没有按组织收窄:${JSON.stringify(c.filters)}`).toBe(
        true,
      );
    }
  });
});

describe("源码级守卫", () => {
  const SOURCE = readFileSync(
    resolve(__dirname, "../../src/lib/mcp/tools.ts"),
    "utf8",
  );

  it("每个 .from( 后面都要有 organization_id 收窄", () => {
    // 笨办法,但挡的是最常见的成因:以后新加一个工具时忘了写那一句。
    // 这条链路没有 RLS 兜底,忘了不会报错,只会静默泄露。
    const blocks = SOURCE.split(/\.from\(/).slice(1);
    for (const block of blocks) {
      const window = block.slice(0, 700);
      const scoped =
        window.includes("organization_id") ||
        // organizations 表按主键 id 等值查询,等价于按组织收窄
        /^"organizations"/.test(window);
      expect(scoped, `有一处 .from( 没带组织收窄:${window.slice(0, 90)}`).toBe(true);
    }
  });

  it("注释里写明了「没有第二道网」,不靠人记着", () => {
    expect(SOURCE).toMatch(/唯一防线|没有第二道网/);
  });
});
