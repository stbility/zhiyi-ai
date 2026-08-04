import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 私钥指纹必须与 GitHub 页面上列出的那一串**逐字符相同**,否则毫无用处。
 *
 * 这个功能是用来终结一轮反复猜测的:GitHub 对「私钥不属于这个 App」
 * 返回的原话是 `A JSON web token could not be decoded` —— 听起来像是
 * JWT 拼错了,于是排查方向被带偏了好几轮。实测复现过:
 *
 *   假 Client ID + 任意密钥        → 'Issuer' claim ('iss') must be an Integer
 *   真 Client ID + 不匹配的密钥    → A JSON web token could not be decoded
 *
 * 指纹让这件事变成一眼可判。但前提是**算得和 GitHub 一样** ——
 * 算错了比不算更糟:用户会拿两串不同的东西比对,然后得出错误结论。
 *
 * 所以这里不自己定义"正确",而是直接跑官方文档给的那条 openssl 命令,
 * 拿它的输出当基准:
 *   openssl rsa -in KEY.pem -pubout -outform DER | openssl sha256 -binary | openssl base64
 */

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return await import("@/lib/integrations/github");
}

/**
 * 密钥只生成一次,各用例复用。
 *
 * 生成一把 2048 位 RSA 要一到三秒,在用例里现生成会撞上 5 秒超时 ——
 * 而那是**测试自己慢**,不是被测代码有问题。这种红是噪声,
 * 会掩盖真正的失败。
 */
const KEY_A = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
}) as string;
const KEY_B = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
}) as string;

/** 用官方那条命令算一遍,作为基准 */
function officialFingerprint(pemPath: string): string {
  const der = execFileSync("openssl", ["rsa", "-in", pemPath, "-pubout", "-outform", "DER"]);
  const sha = execFileSync("openssl", ["sha256", "-binary"], { input: der });
  return execFileSync("openssl", ["base64"], { input: sha }).toString().trim();
}

describe("私钥指纹与 GitHub 的算法一致", () => {
  it("和官方 openssl 命令算出同一串", async () => {
    const { privateKeyFingerprint } = await load();

    const pem = KEY_A;
    const dir = mkdtempSync(join(tmpdir(), "fp-"));
    const file = join(dir, "k.pem");
    writeFileSync(file, pem);

    const ours = privateKeyFingerprint({
      clientId: "Iv23liXXXXXXXXXXXXXX",
      privateKey: pem,
      slug: null,
    });

    expect(ours).toBe(officialFingerprint(file));
  });

  it("两把不同的密钥指纹不同 —— 否则比对没有意义", async () => {
    // 正向对照:少了这条,一个恒返回同一串的实现也能通过上一条
    const { privateKeyFingerprint } = await load();
    const a = privateKeyFingerprint({ clientId: "x", privateKey: KEY_A, slug: null });
    const b = privateKeyFingerprint({ clientId: "x", privateKey: KEY_B, slug: null });
    expect(a).not.toBe(b);
    expect(a).toBeTruthy();
  });

  it("私钥解析不了时返回 null,不抛错", async () => {
    // 卡片渲染在服务端组件里,这里抛错会让整个集成页白屏 ——
    // 而用户来这个页面正是因为凭据有问题
    const { privateKeyFingerprint } = await load();
    expect(
      privateKeyFingerprint({ clientId: "x", privateKey: "不是 PEM", slug: null }),
    ).toBeNull();
  });

  it("指纹里不含私钥的任何片段", async () => {
    const { privateKeyFingerprint } = await load();
    const pem = KEY_A;
    const fp = privateKeyFingerprint({ clientId: "x", privateKey: pem, slug: null })!;

    // 指纹是公钥的哈希,44 个字符的 base64。私钥正文一行都不该出现在里面
    expect(fp).toHaveLength(44);
    for (const line of pem.trim().split("\n").slice(1, -1)) {
      expect(fp).not.toContain(line.slice(0, 20));
    }
  });
});
