import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 站点地址解析测试。
 *
 * 这个地址决定 OAuth 回调、邮箱验证链接、Stripe 回跳落到哪里,选错就是登录不了。
 *
 * 曾经踩过的坑:用了 VERCEL_URL。据 Vercel 官方文档,它是「生成的部署 URL 的域名」,
 * 每次部署都不同;而 VERCEL_PROJECT_PRODUCTION_URL 是「项目的生产域名,
 * 即使在预览部署中也始终有值,适合可靠地生成指向生产的链接」。
 *
 * 用错的后果:OAuth 授权后跳回预览域名,而该域名不在 Google/GitHub 的
 * 回调白名单里,登录必然失败。这个顺序必须锁死。
 */

const ORIGINAL_ENV = process.env;

const VERCEL_KEYS = [
  "NEXT_PUBLIC_SITE_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
];

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return import("@/lib/env/server");
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  for (const k of VERCEL_KEYS) delete process.env[k];
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.doUnmock("server-only");
});

describe("站点地址解析", () => {
  it("显式配置优先级最高", async () => {
    process.env["NEXT_PUBLIC_SITE_URL"] = "https://zhiyi.example.com";
    process.env["VERCEL_PROJECT_PRODUCTION_URL"] = "prod.vercel.app";
    process.env["VERCEL_URL"] = "preview-abc123.vercel.app";

    const { getSiteUrl } = await load();
    expect(getSiteUrl()).toBe("https://zhiyi.example.com");
  });

  it("无显式配置时用稳定生产域名,而非每次部署都变的临时域名", async () => {
    process.env["VERCEL_PROJECT_PRODUCTION_URL"] = "zhiyi-ai.vercel.app";
    process.env["VERCEL_URL"] = "zhiyi-rf6fi1pi4-vivian10.vercel.app";

    const { getSiteUrl } = await load();
    expect(getSiteUrl()).toBe("https://zhiyi-ai.vercel.app");
    // 绝不能落到预览域名 —— 它不在 OAuth 回调白名单里
    expect(getSiteUrl()).not.toContain("rf6fi1pi4");
  });

  it("只有临时域名可用时才退而求其次", async () => {
    process.env["VERCEL_URL"] = "zhiyi-abc.vercel.app";
    const { getSiteUrl } = await load();
    expect(getSiteUrl()).toBe("https://zhiyi-abc.vercel.app");
  });

  it("本地开发回落到 localhost", async () => {
    const { getSiteUrl } = await load();
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("返回值不带结尾斜杠 —— 拼接回调路径时不会出现双斜杠", async () => {
    process.env["VERCEL_PROJECT_PRODUCTION_URL"] = "zhiyi-ai.vercel.app";
    const { getSiteUrl } = await load();
    expect(getSiteUrl().endsWith("/")).toBe(false);
    expect(`${getSiteUrl()}/auth/callback`).toBe(
      "https://zhiyi-ai.vercel.app/auth/callback",
    );
  });
});
