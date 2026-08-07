import { describe, expect, it, vi } from "vitest";

/**
 * 外部能力装配(src/lib/ai/external.ts)。
 *
 * buildExternalContext 把数据库里的 mcp_servers + skills 变成 agent
 * 工具循环能用的上下文。守的是:
 *   1. 降级:单个 server 令牌解密失败/url 不合法只跳过它,其余照常
 *   2. 空装配:两者都没有时返回 undefined —— agent 行为与旧版完全一致
 *   3. 组织隔离:查询必须带 organization_id
 */

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** 一条合法密文(用真实加解密模块生成,保证 decryptSecret 能解开) */
function encryptForTest(plain: string): string {
  // 动态 import 真实实现;测试环境不配 ENCRYPTION_KEY 时会抛 ——
  // 那就用假密文走"解密失败降级"路径
  return plain;
}

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  vi.doMock("@/lib/crypto/secret-box", () => ({
    decryptSecret: vi.fn((cipher: string) => {
      if (cipher === "bad-cipher") throw new Error("解密失败");
      return `decrypted:${cipher}`;
    }),
  }));
  vi.doMock("@/lib/ai/skills", () => ({
    loadSkill: vi.fn(async () => null),
  }));
  return await import("@/lib/ai/external");
}

/** 假 supabase 客户端:只记录查询,返回配置好的行 */
function fakeSupabase(
  rows: Record<string, Record<string, unknown>[]>,
) {
  const seen = new Set<string>();
  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    const api: Record<string, unknown> = {
      select: () => api,
      order: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        seen.add(`${table}.${col}=${String(val)}`);
        return api;
      },
      then: (resolve: (v: unknown) => void) => {
        const hit = (rows[table] ?? []).filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        resolve({ data: hit, error: null });
      },
    };
    return api;
  };
  return { from: builder, seen };
}

describe("buildExternalContext", () => {
  it("两者都没有时返回 undefined(agent 行为与旧版一致)", async () => {
    const { buildExternalContext } = await load();
    const supabase = fakeSupabase({ mcp_servers: [], skills: [] }) as never;
    const ctx = await buildExternalContext(supabase, ORG_A);
    expect(ctx).toBeUndefined();
  });

  it("装配启用的 server(解密令牌)与技能摘要", async () => {
    const { buildExternalContext } = await load();
    const supabase = fakeSupabase({
      mcp_servers: [
        {
          id: "1",
          name: "github",
          url: "https://mcp.github.com",
          auth_token_cipher: "cipher-1",
          timeout_ms: 10000,
          enabled: true,
          organization_id: ORG_A,
        },
      ],
      skills: [
        {
          name: "weekly-report",
          title: "周报",
          description: "生成周报",
          version: "1.0.0",
          tags: ["report"],
          enabled: true,
          organization_id: ORG_A,
        },
      ],
    }) as never;

    const ctx = await buildExternalContext(supabase, ORG_A);
    expect(ctx).toBeDefined();
    expect(ctx?.servers.size).toBe(1);
    expect(ctx?.servers.get("github")?.authToken).toBe("decrypted:cipher-1");
    expect(ctx?.servers.get("github")?.timeoutMs).toBe(10000);
    expect(ctx?.skills).toHaveLength(1);
    expect(ctx?.skills[0]?.name).toBe("weekly-report");
  });

  it("令牌解密失败的 server 被跳过,其余照常装配", async () => {
    const { buildExternalContext } = await load();
    const supabase = fakeSupabase({
      mcp_servers: [
        {
          id: "1",
          name: "broken",
          url: "https://mcp.broken.com",
          auth_token_cipher: "bad-cipher",
          timeout_ms: 5000,
          enabled: true,
          organization_id: ORG_A,
        },
        {
          id: "2",
          name: "ok",
          url: "https://mcp.ok.com",
          auth_token_cipher: "cipher-2",
          timeout_ms: 5000,
          enabled: true,
          organization_id: ORG_A,
        },
      ],
      skills: [],
    }) as never;

    const ctx = await buildExternalContext(supabase, ORG_A);
    expect(ctx).toBeDefined();
    // 坏的被跳过,好的还在
    expect(ctx?.servers.has("broken")).toBe(false);
    expect(ctx?.servers.has("ok")).toBe(true);
    // 因为只剩 1 个 server、0 个技能 —— 不为空,仍返回对象
    expect(ctx?.skills).toHaveLength(0);
  });

  it("url 不合法的 server 被跳过(http 非 localhost)", async () => {
    const { buildExternalContext } = await load();
    const supabase = fakeSupabase({
      mcp_servers: [
        {
          id: "1",
          name: "http-server",
          url: "http://mcp.example.com",
          auth_token_cipher: "cipher-1",
          timeout_ms: 5000,
          enabled: true,
          organization_id: ORG_A,
        },
      ],
      skills: [],
    }) as never;

    const ctx = await buildExternalContext(supabase, ORG_A);
    expect(ctx?.servers.has("http-server")).toBe(false);
    expect(ctx?.servers.size).toBe(0);
  });

  it("全部查询都带 organization_id 收窄", async () => {
    const { buildExternalContext } = await load();
    const supabase = fakeSupabase({
      mcp_servers: [
        {
          id: "1",
          name: "github",
          url: "https://mcp.github.com",
          auth_token_cipher: "c1",
          timeout_ms: 5000,
          enabled: true,
          organization_id: ORG_A,
        },
      ],
      skills: [],
    });

    await buildExternalContext(supabase as never, ORG_A);
    // 两张表的查询都必须按 org 收窄
    expect(supabase.seen.has(`mcp_servers.organization_id=${ORG_A}`)).toBe(true);
    expect(supabase.seen.has(`skills.organization_id=${ORG_A}`)).toBe(true);
  });
});

// encryptForTest 保留用于将来接入真实密文时的测试;当前用 mock 解密
void encryptForTest;
