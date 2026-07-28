"use server";

import { z } from "zod";

import { allowUnverifiedSignup, getSiteUrl } from "@/lib/env/server";
import { createSupabaseAdminClient, hasEmailChannel } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 注册。
 *
 * 为什么要放在服务端而不是直接用浏览器端 signUp:
 *
 * Supabase 自带的邮件服务是「仅供测试」的,每小时只有几封额度。额度用尽时
 * 注册接口直接返回 429,账号根本不会被创建 —— 表现就是「点了注册,什么都没发生,
 * 也进不去系统」。这不是偶发,是没接自有邮件通道时的常态。
 *
 * 因此这里分两条路:
 *   A. 邮件通道可用 —— 走标准注册,发验证邮件,用户验证后才能登录。这是正路。
 *   B. 邮件通道不可用,且运维显式设置了 ALLOW_UNVERIFIED_SIGNUP=true ——
 *      用 service role 直接建号并标记邮箱已确认,不发任何邮件,不受限流影响。
 *
 * B 路默认关闭。它跳过了「邮箱归属权验证」,意味着任何人都能用不属于自己的邮箱
 * 注册并进入系统 —— 这个代价必须由运维显式承担,不能由代码静默降级。
 * 开关关闭时,邮件不可用就如实报错,不偷偷放行。
 *
 * 邮件通道一旦接通,代码自动走回 A 路,无需改动。
 */

const schema = z.object({
  email: z.string().trim().toLowerCase().email("请输入有效的邮箱地址"),
  password: z.string().min(8, "密码至少 8 位").max(72, "密码过长"),
});

export interface RegisterState {
  readonly error?: string;
  readonly hint?: string;
  /** 注册成功,且已发出验证邮件 */
  readonly awaitingVerification?: boolean;
  /** 注册成功,但因邮件通道不可用跳过了邮箱验证 */
  readonly emailVerificationSkipped?: boolean;
}

/** Supabase 的限流错误 —— 账号不会被创建 */
function isRateLimited(message: string): boolean {
  return /rate limit|over_email_send_rate_limit|429/i.test(message);
}

/** 邮件发送失败(SMTP 未配置或配置错误)—— 同样导致账号创建失败 */
function isMailFailure(message: string): boolean {
  return /error sending|smtp|confirmation (mail|email)/i.test(message);
}

export async function register(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "输入不合法" };
  }

  const { email, password } = parsed.data;

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      error: "认证服务未配置,当前无法注册。",
      hint: "缺少 Supabase 地址或公开密钥,请联系管理员。",
    };
  }

  // --- A 路:邮件通道可用,走标准注册 --------------------------------------
  if (hasEmailChannel()) {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${getSiteUrl()}/auth/callback` },
    });

    if (!error) return { awaitingVerification: true };
    if (!isRateLimited(error.message) && !isMailFailure(error.message)) {
      return { error: translate(error.message) };
    }
    // 邮件发送失败 —— 落到 B 路,总比让用户注册不了强
  }

  // --- B 路:跳过邮箱验证直接建号 ------------------------------------------
  //
  // 默认不走这条路。跳过邮箱验证意味着任何人都能用不属于自己的邮箱注册并进入系统,
  // 这个代价必须由运维显式承担,不能由代码替他决定。
  if (!allowUnverifiedSignup()) {
    return {
      error: "邮件服务暂时不可用,当前无法完成注册。",
      hint: "请稍后重试。若持续失败,请联系管理员为 Supabase 配置自有 SMTP。",
    };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return {
      error: "邮件服务未接通,当前无法完成注册。",
      hint: "请联系管理员在 Supabase 配置自有 SMTP,或提供 service role 密钥。",
    };
  }

  const { error: adminError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { email_verification_skipped: true },
  });

  if (adminError) {
    // 邮箱已存在时不回显该事实 —— 避免账号枚举
    if (/already|exists|registered/i.test(adminError.message)) {
      return {
        error: "无法用该邮箱创建账户。",
        hint: "如果该邮箱已注册,请直接登录或使用找回密码。",
      };
    }
    return { error: translate(adminError.message) };
  }

  return { emailVerificationSkipped: true };
}

function translate(message: string): string {
  if (/password/i.test(message) && /short|least/i.test(message)) {
    return "密码长度不足,请设置至少 8 位。";
  }
  if (/invalid/i.test(message) && /email/i.test(message)) {
    return "该邮箱地址无法使用,请换一个。";
  }
  return message;
}
