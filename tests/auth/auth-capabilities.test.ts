import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 认证能力探测测试。
 *
 * 登录页上出现哪些第三方登录按钮,必须由 Supabase 实际启用的 Provider 决定。
 * 写死按钮会得到一个点下去必然报错的空按钮 —— 产品需求明令禁止。
 *
 * 实测发现过:代码里写死了 GitHub 登录按钮,而 Supabase 中 GitHub Provider
 * 从未启用。这个测试防止该类问题复发。
 */

const ORIGINAL_ENV = process.env;
const originalFetch = globalThis.fetch;

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return import("@/lib/supabase/auth-settings");
}

function mockSettings(body: unknown, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://probe.supabase.co";
  process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = "anon-key";
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  globalThis.fetch = originalFetch;
  vi.doUnmock("server-only");
});

describe("认证能力探测", () => {
  it("只返回实际启用的第三方登录方式", async () => {
    mockSettings({
      disable_signup: false,
      mailer_autoconfirm: false,
      external: { email: true, github: false, google: true },
    });

    const { getAuthCapabilities } = await load();
    const caps = await getAuthCapabilities();

    expect(caps.available).toBe(true);
    expect(caps.emailEnabled).toBe(true);
    // github 为 false,绝不能出现在列表里
    expect(caps.oauthProviders).toEqual(["google"]);
  });

  it("全部 Provider 关闭时返回空列表 —— 页面据此不渲染任何按钮", async () => {
    mockSettings({ external: { email: true } });

    const { getAuthCapabilities } = await load();
    expect((await getAuthCapabilities()).oauthProviders).toEqual([]);
  });

  it("识别是否要求邮箱验证", async () => {
    mockSettings({ mailer_autoconfirm: false, external: { email: true } });
    const { getAuthCapabilities } = await load();
    expect((await getAuthCapabilities()).requiresEmailConfirmation).toBe(true);

    mockSettings({ mailer_autoconfirm: true, external: { email: true } });
    const { getAuthCapabilities: again } = await load();
    expect((await again()).requiresEmailConfirmation).toBe(false);
  });

  it("识别是否开放注册", async () => {
    mockSettings({ disable_signup: true, external: { email: true } });
    const { getAuthCapabilities } = await load();
    expect((await getAuthCapabilities()).signupEnabled).toBe(false);
  });

  it("未配置时如实返回不可用,不猜测能力", async () => {
    delete process.env["NEXT_PUBLIC_SUPABASE_URL"];
    delete process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

    const { getAuthCapabilities } = await load();
    const caps = await getAuthCapabilities();

    expect(caps.available).toBe(false);
    expect(caps.emailEnabled).toBe(false);
    expect(caps.oauthProviders).toEqual([]);
  });

  it("服务不可达时降级为不可用,不抛错崩页面", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const { getAuthCapabilities } = await load();
    const caps = await getAuthCapabilities();

    expect(caps.available).toBe(false);
    expect(caps.oauthProviders).toEqual([]);
  });

  it("返回非 200 时同样降级为不可用", async () => {
    mockSettings({}, false);
    const { getAuthCapabilities } = await load();
    expect((await getAuthCapabilities()).available).toBe(false);
  });

  it("不认识的 Provider 不会被透传出去", async () => {
    mockSettings({ external: { email: true, gitlab: true, discord: true } });
    const { getAuthCapabilities } = await load();
    expect((await getAuthCapabilities()).oauthProviders).toEqual([]);
  });
});
