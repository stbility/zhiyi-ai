"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 注册。
 *
 * 设计原则:注册这一步不碰邮件。
 *
 * 为什么:此前走「注册 → 发验证邮件 → 点链接 → 才能登录」,而这条链路在本项目上
 * 根本走不通 ——
 *   1. Supabase 内置邮件服务官方声明「拒绝投递给非项目团队成员的地址」,
 *      要接自有 SMTP 就得先有一个已验证的自有域名,而本项目不打算再买域名;
 *   2. 用已注册过的邮箱重复注册时,Supabase 为防账号枚举会返回一个伪造的
 *      用户对象且**不发任何邮件**,界面却报「请查收邮件」,人就干等在那里。
 * 两条加起来的结果是:注册页把用户挡在门外。
 *
 * 所以现在:直接建号、直接登录、直接进系统,一步到位。
 *
 * 代价说清楚:不验证邮箱归属权,意味着有人可以用不属于自己的邮箱注册。
 * 这是产品方明确做出的取舍(「不要邮箱验证码」),不是代码擅自降级。
 * 日后接通邮件通道要恢复验证,只需把 createUser 的 email_confirm 改回 false。
 */

const schema = z.object({
  email: z.string().trim().toLowerCase().email("请输入有效的邮箱地址"),
  password: z.string().min(8, "密码至少 8 位").max(72, "密码过长"),
});

export interface RegisterState {
  readonly error?: string;
  readonly hint?: string;
  /**
   * 该邮箱已被注册。
   *
   * 措辞上不直接确认「这个邮箱存在」—— 那正是 Supabase 要防的账号枚举 ——
   * 但必须让用户知道下一步该干什么,不能让他干等一封永远不来的邮件。
   */
  readonly alreadyRegistered?: boolean;
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

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return {
      error: "认证服务未完整配置,当前无法注册。",
      hint: "缺少 service role 密钥,请联系管理员。",
    };
  }

  // 建号。email_confirm: true 表示直接标记为已确认,不触发任何邮件。
  const { error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError) {
    if (/already|exists|registered|duplicate/i.test(createError.message)) {
      return { alreadyRegistered: true };
    }
    return { error: translate(createError.message) };
  }

  // 立刻登录,把会话 Cookie 写进响应。
  // 注册完还要用户再手动登一次是多余的一步,而每多一步就多一个卡住的地方。
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    // 账号确实建好了,只是这一步没成 —— 如实说,并指向登录页,不要谎称失败
    return {
      error: "账户已创建,但自动登录失败。",
      hint: "请前往登录页手动登录。",
    };
  }

  redirect("/today");
}

function translate(message: string): string {
  if (/password/i.test(message) && /short|least|weak/i.test(message)) {
    return "密码强度不足,请设置至少 8 位。";
  }
  if (/invalid/i.test(message) && /email/i.test(message)) {
    return "该邮箱地址无法使用,请换一个。";
  }
  return message;
}
