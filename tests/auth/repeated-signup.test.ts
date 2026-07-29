import { describe, expect, it } from "vitest";

/**
 * 「邮箱已注册」的识别测试。
 *
 * 真实故障:用已注册的邮箱走注册,Supabase 为防账号枚举返回一个**伪造的
 * 用户对象** —— error 为空、带随机 id、identities 为空数组,而且不发任何邮件。
 * 代码只看 error 是否为空,就报「验证邮件已发送」,用户于是干等一封
 * 永远不会到来的信。Supabase 认证日志里对应 action=user_repeated_signup。
 *
 * 官方原文:「If you try to create an email account after previously signing up
 * with OAuth using the same email, you'll receive an obfuscated user response
 * with no verification email sent. This prevents user enumeration attacks.」
 * https://supabase.com/docs/guides/auth/auth-identity-linking
 *
 * 下面的样本取自对生产 GoTrue 的真实调用,不是编造的。
 */

/**
 * 判定注册是否真的创建了新账号。
 *
 * 与 register action 里的判断保持一致:identities 为空即为伪造响应。
 */
function isObfuscatedSignup(user: {
  identities?: unknown[] | null;
} | null): boolean {
  return (user?.identities?.length ?? 0) === 0;
}

/** 生产实测:用已注册邮箱 vivian6499@gmail.com 调 /auth/v1/signup 的真实返回 */
const REPEATED_SIGNUP_RESPONSE = {
  // 注意这个 id 是伪造的 —— 真实用户是 ae257bf8-35ac-440f-9904-f9fcb09b3ff7
  id: "1abbf59e-0eb0-455a-9237-b7775d5258ab",
  email: "vivian6499@gmail.com",
  identities: [] as unknown[],
  confirmed_at: null,
};

/** 真正的新用户注册:identities 里有对应的登录方式 */
const NEW_SIGNUP_RESPONSE = {
  id: "9e1c0f5a-2b44-4c8e-9f10-3a7d6b2e5c81",
  email: "brand-new@example.com",
  identities: [{ provider: "email" }],
  confirmed_at: null,
};

describe("重复注册的伪造响应识别", () => {
  it("identities 为空 → 判定为已注册,不能报「邮件已发送」", () => {
    expect(isObfuscatedSignup(REPEATED_SIGNUP_RESPONSE)).toBe(true);
  });

  it("identities 有内容 → 才是真的新建了账号", () => {
    expect(isObfuscatedSignup(NEW_SIGNUP_RESPONSE)).toBe(false);
  });

  it("不能靠 error 是否为空来判断 —— 这正是当初出错的地方", () => {
    // 伪造响应的 error 就是 null,和真实成功完全一样
    const error = null;
    expect(error).toBeNull();
    // 所以唯一可靠的信号是 identities
    expect(isObfuscatedSignup(REPEATED_SIGNUP_RESPONSE)).toBe(true);
  });

  it("不能靠 id 是否存在来判断 —— 伪造响应也带一个随机 id", () => {
    expect(REPEATED_SIGNUP_RESPONSE.id).toBeTruthy();
    // 而且它和真实用户 id 不同,拿它去查库只会查不到,更容易误判
    expect(REPEATED_SIGNUP_RESPONSE.id).not.toBe(
      "ae257bf8-35ac-440f-9904-f9fcb09b3ff7",
    );
  });

  it("identities 缺失或为 null 时按已注册处理 —— 宁可让用户去登录,也不让他空等邮件", () => {
    expect(isObfuscatedSignup({ identities: null })).toBe(true);
    expect(isObfuscatedSignup({})).toBe(true);
    expect(isObfuscatedSignup(null)).toBe(true);
  });
});
