import { describe, expect, it, vi } from "vitest";

/**
 * 调用限流测试。
 *
 * 这是整个系统里唯一会造成**直接金钱损失**的缺口:此前 /api/chat 只校验登录,
 * 一个循环脚本就能把用户配置的服务商配额刷干,账单落在用户头上。
 *
 * 几条不能弄反的性质:
 *   - 超限必须拦住,而且要说清为什么(否则用户以为系统坏了)
 *   - 限流组件自己出故障时要**放行**,不能让所有人用不了对话
 *   - 计数必须走服务端身份,客户端不能自己改
 */

async function load(rpc: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  vi.doMock("@/lib/supabase/admin", () => ({
    createSupabaseAdminClient: () => ({ rpc }),
  }));
  return import("@/lib/services/rate-limit");
}

describe("对话调用限流", () => {
  it("窗口内未超限时放行", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 3, error: null });
    const { checkRateLimit } = await load(rpc);

    const r = await checkRateLimit("chat:user-1");
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("超过每分钟上限时拦住,并说清原因", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 21, error: null });
    const { checkRateLimit } = await load(rpc);

    const r = await checkRateLimit("chat:user-1");
    expect(r.allowed).toBe(false);
    // 必须让用户明白这是保护措施,不是系统坏了
    expect(r.reason).toContain("每分钟");
    expect(r.reason).toContain("配额");
  });

  it("每个窗口独立计数,短窗与长窗都要判", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 1, error: null });
    const { checkRateLimit, CHAT_LIMITS } = await load(rpc);

    await checkRateLimit("chat:user-1");
    expect(rpc).toHaveBeenCalledTimes(CHAT_LIMITS.length);
    // 窗口长度要作为 key 的一部分,否则两个窗口会互相污染计数
    const subjects = rpc.mock.calls.map((c) => c[1].p_subject);
    expect(new Set(subjects).size).toBe(CHAT_LIMITS.length);
  });

  it("限流组件自身故障时放行 —— 不能因为它坏了让所有人用不了", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: "boom" } });
    const { checkRateLimit } = await load(rpc);

    const r = await checkRateLimit("chat:user-1");
    expect(r.allowed).toBe(true);
  });

  it("未配置 service role 时放行,但那属于部署缺失", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/lib/supabase/admin", () => ({
      createSupabaseAdminClient: () => null,
    }));
    const { checkRateLimit } = await import("@/lib/services/rate-limit");

    const r = await checkRateLimit("chat:user-1");
    expect(r.allowed).toBe(true);
  });
});
