import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 服务可用性判定测试。
 *
 * 这条链路直接决定「未配置的第三方服务是否会被伪装为已接通」,
 * 属于产品硬性规则,必须有断言守住。
 */

const ORIGINAL_ENV = process.env;

const MANAGED_PREFIXES = [
  "NEXT_PUBLIC_SUPABASE_",
  "SUPABASE_",
  "STRIPE_",
  "NEXT_PUBLIC_STRIPE_",
];

async function loadAvailability() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return import("@/lib/services/availability");
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  for (const key of Object.keys(process.env)) {
    if (
      MANAGED_PREFIXES.some((p) => key.startsWith(p)) ||
      key === "ENCRYPTION_KEY"
    ) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.doUnmock("server-only");
});

describe("服务可用性", () => {
  it("完全没有凭据时,一律判为未配置 —— 不得回退为可用", async () => {
    const { getServiceAvailability } = await loadAvailability();
    const services = getServiceAvailability();

    expect(services.length).toBeGreaterThan(0);
    for (const service of services) {
      expect(service.status).toBe("unconfigured");
    }
  });

  it("凭据齐备时判为已配置(新命名)", async () => {
    process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://example.supabase.co";
    process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] = "sb_publishable_x";
    process.env["SUPABASE_SECRET_KEY"] = "sb_secret_x";

    const { getServiceAvailability, isServiceConfigured } =
      await loadAvailability();
    const supabase = getServiceAvailability().find((s) => s.key === "supabase");

    expect(supabase?.status).toBe("configured");
    expect(supabase?.missing).toEqual([]);
    expect(isServiceConfigured("supabase")).toBe(true);
  });

  it("凭据齐备时判为已配置(Vercel 集成的旧命名)", async () => {
    process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://example.supabase.co";
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = "anon-key";
    process.env["SUPABASE_SERVICE_ROLE_KEY"] = "service-role-key";

    const { isServiceConfigured } = await loadAvailability();

    expect(isServiceConfigured("supabase")).toBe(true);
  });

  it("新旧命名混用也能识别", async () => {
    process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://example.supabase.co";
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = "anon-key";
    process.env["SUPABASE_SECRET_KEY"] = "sb_secret_x";

    const { isServiceConfigured } = await loadAvailability();

    expect(isServiceConfigured("supabase")).toBe(true);
  });

  it("只填一部分时判为配置不完整,并列出缺失变量名的全部可选命名", async () => {
    process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://example.supabase.co";

    const { getServiceAvailability } = await loadAvailability();
    const supabase = getServiceAvailability().find((s) => s.key === "supabase");

    expect(supabase?.status).toBe("incomplete");
    expect(supabase?.missing).toEqual([
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY 或 NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SECRET_KEY 或 SUPABASE_SERVICE_ROLE_KEY",
    ]);
  });

  it("空字符串视作未配置,不得当成已填写", async () => {
    process.env["ENCRYPTION_KEY"] = "   ";

    const { getServiceAvailability } = await loadAvailability();
    const encryption = getServiceAvailability().find(
      (s) => s.key === "encryption",
    );

    expect(encryption?.status).toBe("unconfigured");
  });

  it("缺失清单只含变量名,绝不含变量值", async () => {
    process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://example.supabase.co";
    process.env["STRIPE_SECRET_KEY"] = "sk_test_super_secret_value";

    const { getServiceAvailability } = await loadAvailability();
    const serialized = JSON.stringify(getServiceAvailability());

    expect(serialized).not.toContain("example.supabase.co");
    expect(serialized).not.toContain("sk_test_super_secret_value");
  });

  it("AI Provider 不登记在环境变量注册表中 —— 密钥由产品内添加", async () => {
    const { getServiceAvailability } = await loadAvailability();
    const keys = getServiceAvailability().map((s) => s.key);

    expect(keys.some((k) => k.startsWith("provider:"))).toBe(false);
  });
});

describe("密钥掩码", () => {
  it("只保留末四位,未配置时如实说明", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { maskSecret } = await import("@/lib/env/server");

    expect(maskSecret(undefined)).toBe("(未配置)");
    expect(maskSecret("sk-abcdefghijklmnop")).toBe("****mnop");
    expect(maskSecret("sk-abcdefghijklmnop")).not.toContain("abcdefgh");
    expect(maskSecret("short")).toBe("****");
  });
});
