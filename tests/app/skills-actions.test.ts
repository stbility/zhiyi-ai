import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 技能库 Server Actions(skills-actions.ts)。
 *
 * 守的是:
 *   1. 导入必须走 frontmatter 解析 —— 解析失败给出能照着改的错误,
 *      绝不把半成品塞进库
 *   2. RLS 拒绝(42501)要说清是权限问题
 *   3. 同名技能(23505)要说清是重名
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/** 可变 mock:每个测试设置 supabase 替身 */
let mockSupabase: ReturnType<typeof fakeSupabase> | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => mockSupabase,
}));

const ORG = "11111111-1111-4111-8111-111111111111";

/** 与 server-action-failures.test.ts 同模式的 Supabase 替身 */
function fakeSupabase(result: {
  count?: number | null;
  error?: { message: string; code?: string } | null;
  data?: unknown;
  insert?: (v: Record<string, unknown>) => { error: { message: string; code?: string } | null };
}) {
  const settled = {
    count: result.count ?? null,
    error: result.error ?? null,
    data: result.data ?? null,
  };
  const chain: Record<string, unknown> = {
    delete: () => chain,
    select: () => chain,
    // insert 默认返回传入的 error(RLS/唯一约束都从 insert 出来)
    insert: result.insert ?? (() => ({ error: result.error ?? null })),
    update: () => chain,
    eq: () => chain,
    order: () => chain,
    maybeSingle: () => chain,
    then: (resolve: (v: typeof settled) => unknown) => resolve(settled),
  };
  return {
    from: () => chain,
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
  };
}

async function load() {
  const mod = await import("@/app/(app)/settings/skills/skills-actions");
  return mod;
}

const VALID_SKILL = `---
name: weekly-report
title: 周报生成
description: Use when generating a weekly report.
version: 1.0.0
tags: [report]
---

# 周报
1. 汇总 commits
2. 输出
`;

function form(markdown: string = VALID_SKILL): FormData {
  const f = new FormData();
  f.set("organizationId", ORG);
  f.set("markdown", markdown);
  return f;
}

function idForm(): FormData {
  const f = new FormData();
  f.set("id", "22222222-2222-4222-8222-222222222222");
  f.set("organizationId", ORG);
  return f;
}

describe("importSkill", () => {
  beforeEach(() => {
    mockSupabase = fakeSupabase({});
  });

  it("导入成功:frontmatter 解析后入库", async () => {
    const captured: { value: Record<string, unknown> | null } = { value: null };
    mockSupabase = fakeSupabase({
      insert: (v: Record<string, unknown>) => {
        captured.value = v;
        return { error: null };
      },
    });

    const { importSkill } = await load();
    const result = await importSkill({}, form());
    expect(result.error).toBeUndefined();
    expect(result.ok).toContain("weekly-report");
    const inserted = captured.value;
    expect(inserted?.name).toBe("weekly-report");
    expect(inserted?.title).toBe("周报生成");
    expect(inserted?.description).toBe("Use when generating a weekly report.");
    expect(inserted?.body).toContain("汇总 commits");
    expect(inserted?.tags).toEqual(["report"]);
  });

  it("frontmatter 解析失败给出能照着改的错误", async () => {
    const { importSkill } = await load();
    const result = await importSkill({}, form("# 没有 frontmatter\n正文"));
    expect(result.ok).toBeUndefined();
    expect(result.error).toContain("frontmatter");
  });

  it("缺少 description 明确报错", async () => {
    const { importSkill } = await load();
    const noDesc = form("---\nname: no-desc\n---\n正文");
    const result = await importSkill({}, noDesc);
    expect(result.error).toContain("description");
  });

  it("RLS 拒绝(42501)说清是权限问题", async () => {
    mockSupabase = fakeSupabase({
      error: { message: "permission denied", code: "42501" },
    });
    const { importSkill } = await load();
    const result = await importSkill({}, form());
    expect(result.error).toContain("权限");
  });

  it("同名技能(23505)明确报重名", async () => {
    mockSupabase = fakeSupabase({
      error: { message: "duplicate key", code: "23505" },
    });
    const { importSkill } = await load();
    const result = await importSkill({}, form());
    expect(result.error).toContain("已存在");
  });
});

describe("toggleSkill / deleteSkill", () => {
  beforeEach(() => {
    mockSupabase = fakeSupabase({});
  });

  it("toggleSkill 空结果(count 0)不报假成功", async () => {
    mockSupabase = fakeSupabase({ count: 0, data: { name: "x", enabled: true } });
    const { toggleSkill } = await load();
    const result = await toggleSkill({}, idForm());
    expect(result.ok).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it("deleteSkill RLS 拒绝说清权限", async () => {
    mockSupabase = fakeSupabase({
      error: { message: "permission denied", code: "42501" },
    });
    const { deleteSkill } = await load();
    const result = await deleteSkill({}, idForm());
    expect(result.error).toContain("权限");
  });
});
