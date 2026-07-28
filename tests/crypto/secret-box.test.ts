import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 密钥加密测试。
 *
 * 这是存放第三方 API 密钥的最后一道防线,必须逐项验证:
 *   - 密文被篡改必须解密失败,而不是解出一段垃圾(对密钥而言后者更危险)
 *   - 相同明文两次加密必须产生不同密文,否则能从库里看出谁和谁配了同一把密钥
 *   - 密钥未配置时必须明确失败,绝不能退化成明文存储
 */

const ORIGINAL_ENV = process.env;
const VALID_KEY = randomBytes(32).toString("base64");

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return import("@/lib/crypto/secret-box");
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env["ENCRYPTION_KEY"] = VALID_KEY;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.doUnmock("server-only");
});

describe("密钥加密", () => {
  it("加密后能原样解回", async () => {
    const { encryptSecret, decryptSecret } = await load();
    const secret = "sk-test-abcdefghijklmnopqrstuvwxyz";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("密文中不含明文", async () => {
    const { encryptSecret } = await load();
    const secret = "sk-super-secret-value";
    expect(encryptSecret(secret)).not.toContain(secret);
  });

  it("相同明文两次加密产生不同密文", async () => {
    const { encryptSecret } = await load();
    const secret = "sk-same-input";
    // 若相同,攻击者能从数据库看出哪些组织用了同一把密钥
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it("密文被篡改时解密失败,而不是返回垃圾", async () => {
    const { encryptSecret, decryptSecret } = await load();
    const parts = encryptSecret("sk-tampered").split(".");

    // 必须翻转解码后的真实字节:base64url 末位字符的部分比特在解码时会被丢弃,
    // 直接改末位字符有可能根本没改到密文,那样这个测试就形同虚设。
    const cipher = Buffer.from(parts[3] as string, "base64url");
    cipher[0] = (cipher[0] as number) ^ 0xff;

    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      cipher.toString("base64url"),
    ].join(".");

    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("authTag 被篡改时解密失败", async () => {
    const { encryptSecret, decryptSecret } = await load();
    const parts = encryptSecret("sk-tag-check").split(".");

    const tag = Buffer.from(parts[2] as string, "base64url");
    tag[0] = (tag[0] as number) ^ 0xff;

    expect(() =>
      decryptSecret(
        [parts[0], parts[1], tag.toString("base64url"), parts[3]].join("."),
      ),
    ).toThrow();
  });

  it("换一把密钥无法解开", async () => {
    const { encryptSecret } = await load();
    const payload = encryptSecret("sk-other-key");

    process.env["ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
    const { decryptSecret } = await load();

    expect(() => decryptSecret(payload)).toThrow();
  });

  it("未配置密钥时明确失败,绝不退化为明文", async () => {
    delete process.env["ENCRYPTION_KEY"];
    const { encryptSecret, isEncryptionAvailable } = await load();

    expect(isEncryptionAvailable()).toBe(false);
    expect(() => encryptSecret("sk-should-not-store")).toThrow();
  });

  it("密钥长度不足时明确失败", async () => {
    process.env["ENCRYPTION_KEY"] = randomBytes(16).toString("base64");
    const { isEncryptionAvailable, encryptSecret } = await load();

    expect(isEncryptionAvailable()).toBe(false);
    expect(() => encryptSecret("sk-short-key")).toThrow(/32 字节/);
  });

  it("格式无法识别的密文直接拒绝", async () => {
    const { decryptSecret } = await load();
    expect(() => decryptSecret("这不是密文")).toThrow();
    expect(() => decryptSecret("v2.a.b.c")).toThrow();
  });
});

describe("密钥掩码", () => {
  it("只保留末四位", async () => {
    const { maskApiKey } = await load();
    const masked = maskApiKey("sk-abcdefghijklmnop");
    expect(masked).toBe("••••••••mnop");
    expect(masked).not.toContain("abcdefgh");
  });

  it("过短的密钥全部遮蔽", async () => {
    const { maskApiKey } = await load();
    expect(maskApiKey("short")).toBe("••••");
  });
});
