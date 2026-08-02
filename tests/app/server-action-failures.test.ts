import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server Action 的失败必须如实反馈。
 *
 * 两类此前静默的问题:
 *
 * 1. 删除被 RLS 拦下时仍报「已删除」。PostgREST 在 0 行匹配时**不返回错误**,
 *    而代码只判 error —— 于是越权删除得到一句成功提示,用户以为删掉了,
 *    刷新一看还在。
 *
 * 2. 写库失败静默。RLS 拒绝时模型照常被调用、配额照常消耗,
 *    却什么都没存下,而 messages 正是用量计费的唯一依据。
 *
 * 这些都在原来的测试盲区里:253 个测试没有一个覆盖 Server Action。
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * 能按需返回 count / error 的 Supabase 替身。
 *
 * 写成显式的链式对象而不是 Proxy —— Proxy 要同时扮演「可继续链式调用」
 * 和「可 await」两种角色,边界很容易出错,测试替身本身出 bug 比没有测试更糟。
 */
function fakeSupabase(result: {
  count?: number | null;
  error?: { message: string } | null;
}) {
  const settled = {
    count: result.count ?? null,
    error: result.error ?? null,
    data: null,
  };

  const chain = {
    delete: () => chain,
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    upsert: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => chain,
    single: () => chain,
    then: (resolve: (v: typeof settled) => unknown) => resolve(settled),
  };

  return { from: () => chain };
}

const supabaseRef: { current: unknown } = { current: null };
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => supabaseRef.current,
}));

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.resetModules();
});

describe("删除操作的反馈", () => {
  it("0 行被删时如实报告,而不是说「已删除」", async () => {
    // RLS 拦下越权删除:PostgREST 返回 count=0 且 error=null
    supabaseRef.current = fakeSupabase({ count: 0, error: null });
    const { deleteWorkspaceFile } = await import("@/app/(app)/workspace/actions");

    const state = await deleteWorkspaceFile(
      {},
      formData({ workspaceId: WORKSPACE_ID, path: "src/a.ts" }),
    );

    expect(state.error).toBeTruthy();
    expect(state.error).toContain("没有权限");
    expect(state.ok).toBeUndefined();
  });

  it("真的删掉时才算成功", async () => {
    supabaseRef.current = fakeSupabase({ count: 1, error: null });
    const { deleteWorkspaceFile } = await import("@/app/(app)/workspace/actions");

    const state = await deleteWorkspaceFile(
      {},
      formData({ workspaceId: WORKSPACE_ID, path: "src/a.ts" }),
    );

    expect(state.error).toBeUndefined();
  });

  it("数据库报错时原样透出,不粉饰", async () => {
    supabaseRef.current = fakeSupabase({
      count: null,
      error: { message: "permission denied for table workspace_files" },
    });
    const { deleteWorkspaceFile } = await import("@/app/(app)/workspace/actions");

    const state = await deleteWorkspaceFile(
      {},
      formData({ workspaceId: WORKSPACE_ID, path: "src/a.ts" }),
    );

    expect(state.error).toContain("permission denied");
  });

  it("参数非法时不碰数据库", async () => {
    supabaseRef.current = fakeSupabase({ count: 1, error: null });
    const { deleteWorkspaceFile } = await import("@/app/(app)/workspace/actions");

    const state = await deleteWorkspaceFile({}, formData({ workspaceId: "不是 uuid", path: "" }));
    expect(state.error).toBe("参数无效");
  });
});
