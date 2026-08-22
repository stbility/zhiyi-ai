import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OAuth Provider 契约测试(P1-AUTH-002)。
 *
 * 三层契约,缺一层 Microsoft 登录入口就不可用:
 * 1. Supabase 侧真实启用(运行时 /auth/v1/settings 的 external.azure)
 * 2. 代码白名单 SUPPORTED_OAUTH_PROVIDERS 含对应 id(键名必须与 GoTrue
 *    一致 —— Microsoft 在 GoTrue 的键是 "azure",实证)
 * 3. 按钮组件 PROVIDERS 数组渲染对应入口
 */

const ORIGINAL_ENV = process.env;
const originalFetch = globalThis.fetch;

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return import("@/lib/supabase/auth-settings");
}

function mockSettings(body: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
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

describe("OAuth Provider 契约", () => {
  it("Microsoft 在 Supabase 启用时出现在 oauthProviders 列表", async () => {
    mockSettings({
      external: { email: true, azure: true, github: false, google: false },
    });

    const { getAuthCapabilities } = await load();
    const caps = await getAuthCapabilities();

    expect(caps.oauthProviders).toContain("azure");
  });

  it("Microsoft 未启用时不出现在列表", async () => {
    mockSettings({
      external: { email: true, azure: false, github: true, google: true },
    });

    const { getAuthCapabilities } = await load();
    const caps = await getAuthCapabilities();

    expect(caps.oauthProviders).not.toContain("azure");
  });

  it("代码白名单含 azure —— 键名与 GoTrue settings 一致", async () => {
    const mod = await load();
    expect(mod.SUPPORTED_OAUTH_PROVIDERS).toContain("azure");
  });

  it("按钮组件渲染 Microsoft 入口", () => {
    const buttons = readFileSync(
      resolve(__dirname, "../../src/components/auth/OAuthButtons.tsx"),
      "utf8",
    );
    expect(buttons).toMatch(/id:\s*"azure"/);
    expect(buttons).toMatch(/使用 Microsoft 继续/);
  });

  it("品牌标识文件含 MicrosoftMark", () => {
    const marks = readFileSync(
      resolve(__dirname, "../../src/components/auth/BrandMarks.tsx"),
      "utf8",
    );
    expect(marks).toMatch(/export function MicrosoftMark/);
  });
});
