import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 「跳过邮箱验证」开关的默认值测试。
 *
 * 这个开关一旦默认打开,任何人都能用不属于自己的邮箱注册并进入系统。
 * 它必须默认关闭,且只认严格的 "true" —— 安全开关不做宽松解析,
 * 否则一个手滑的 "false"、"0"、"no" 都可能被当成开启。
 *
 * 该文件存在的意义就是防止有人(包括后续的 AI 改动)把默认值改反。
 */

const ORIGINAL_ENV = process.env;

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return import("@/lib/env/server");
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env["ALLOW_UNVERIFIED_SIGNUP"];
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.doUnmock("server-only");
});

describe("跳过邮箱验证的安全开关", () => {
  it("未设置时必须为关闭 —— 这是默认的安全姿态", async () => {
    const { allowUnverifiedSignup } = await load();
    expect(allowUnverifiedSignup()).toBe(false);
  });

  it("只有严格等于 \"true\" 才开启", async () => {
    process.env["ALLOW_UNVERIFIED_SIGNUP"] = "true";
    const { allowUnverifiedSignup } = await load();
    expect(allowUnverifiedSignup()).toBe(true);
  });

  it("其它任何取值一律视为关闭", async () => {
    // 注意不含带空格的 " true":环境变量在 schema 层会被 trim,
    // 粘贴时多一个空格仍应视为用户想开启,这是合理的宽容。
    // 真正危险的是把 "1"/"yes"/"TRUE" 当成开启 —— 那些必须保持关闭。
    for (const value of ["false", "0", "1", "yes", "no", "TRUE", "True", "on", ""]) {
      process.env["ALLOW_UNVERIFIED_SIGNUP"] = value;
      const { allowUnverifiedSignup } = await load();
      expect(allowUnverifiedSignup(), `取值 ${JSON.stringify(value)} 不应开启`).toBe(
        false,
      );
    }
  });

  it("前后空格被容忍 —— 粘贴时多一个空格不该让开关失效", async () => {
    process.env["ALLOW_UNVERIFIED_SIGNUP"] = "  true  ";
    const { allowUnverifiedSignup } = await load();
    expect(allowUnverifiedSignup()).toBe(true);
  });
});
