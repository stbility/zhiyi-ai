import { describe, expect, it, vi } from "vitest";

/**
 * 凭据格式校验测试。
 *
 * 「填了」不等于「填对了」。这些都是真实发生过或极易发生的误填:
 *   - 把生成命令原文当成密钥填进去
 *   - 把 Webhook 签名密钥填成接收地址
 *   - 把 Stripe 可公开密钥填到服务端密钥位置
 *
 * 其中 Webhook 密钥填错最危险:验签会恒失败,订阅状态永远同步不上;
 * 若代码未严格校验,更等于放任伪造的付款成功请求。必须显式暴露。
 */

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return import("@/lib/env/validate");
}

describe("ENCRYPTION_KEY 校验", () => {
  it("未配置不算格式错误", async () => {
    const { validateEncryptionKey } = await load();
    expect(validateEncryptionKey(undefined)).toBeNull();
  });

  it("合法的 32 字节 base64 通过", async () => {
    const { validateEncryptionKey } = await load();
    const key = Buffer.alloc(32, 7).toString("base64");
    expect(validateEncryptionKey(key)).toBeNull();
  });

  it("误把生成命令原文填进来会被识别", async () => {
    const { validateEncryptionKey } = await load();
    const issue = validateEncryptionKey("openssl rand -base64 32");
    expect(issue).not.toBeNull();
    expect(issue?.message).toContain("生成命令本身");
  });

  it("长度不足 32 字节被拒绝", async () => {
    const { validateEncryptionKey } = await load();
    const short = Buffer.alloc(16, 1).toString("base64");
    const issue = validateEncryptionKey(short);
    expect(issue?.message).toContain("16 字节");
  });

  it("非 base64 字符被拒绝", async () => {
    const { validateEncryptionKey } = await load();
    expect(validateEncryptionKey("这不是 base64!!")).not.toBeNull();
  });

  it("报错信息不回显密钥内容", async () => {
    const { validateEncryptionKey } = await load();
    const secret = Buffer.alloc(16, 9).toString("base64");
    const issue = validateEncryptionKey(secret);
    expect(JSON.stringify(issue)).not.toContain(secret);
  });
});

describe("STRIPE_WEBHOOK_SECRET 校验", () => {
  it("合法的 whsec_ 值通过", async () => {
    const { validateStripeWebhookSecret } = await load();
    expect(validateStripeWebhookSecret("whsec_abc123")).toBeNull();
  });

  it("填成网址会被识别 —— 这会让验签恒失败", async () => {
    const { validateStripeWebhookSecret } = await load();
    const issue = validateStripeWebhookSecret("https://zhiyi-ai.vercel.app");
    expect(issue).not.toBeNull();
    expect(issue?.message).toContain("网址");
    expect(issue?.fix).toContain("Signing secret");
  });

  it("前缀不对会被识别", async () => {
    const { validateStripeWebhookSecret } = await load();
    expect(validateStripeWebhookSecret("sk_test_x")).not.toBeNull();
  });
});

describe("STRIPE_SECRET_KEY 校验", () => {
  it("sk_ 与 rk_ 通过", async () => {
    const { validateStripeSecretKey } = await load();
    expect(validateStripeSecretKey("sk_test_x")).toBeNull();
    expect(validateStripeSecretKey("rk_test_x")).toBeNull();
  });

  it("误填可公开密钥会被识别", async () => {
    const { validateStripeSecretKey } = await load();
    const issue = validateStripeSecretKey("pk_test_x");
    expect(issue?.message).toContain("可公开密钥");
  });
});

describe("Supabase 地址校验", () => {
  it("合法项目地址通过", async () => {
    const { validateSupabaseUrl } = await load();
    expect(
      validateSupabaseUrl("https://ullmdnbgtauupndwqqzd.supabase.co"),
    ).toBeNull();
  });

  it("非 Supabase 域名被拒绝", async () => {
    const { validateSupabaseUrl } = await load();
    expect(validateSupabaseUrl("https://example.com")).not.toBeNull();
  });
});

describe("可用性注册表接入格式校验", () => {
  it("格式错误时状态为 invalid,优先于 configured", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));

    const original = process.env;
    process.env = { ...original };
    process.env["ENCRYPTION_KEY"] = "openssl rand -base64 32";

    const { getServiceAvailability } = await import(
      "@/lib/services/availability"
    );
    const encryption = getServiceAvailability().find(
      (s) => s.key === "encryption",
    );

    expect(encryption?.status).toBe("invalid");
    expect(encryption?.issues.length).toBeGreaterThan(0);

    process.env = original;
  });
});
