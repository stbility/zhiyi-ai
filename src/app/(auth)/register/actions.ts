"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { randomUUID } from "node:crypto";

import { headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/log";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  REGISTER_LIMITS,
  checkRateLimit,
} from "@/lib/services/rate-limit";
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

  // 注册限流。
  //
  // 下面用的是 service role 建号,那条路径绕过了 Supabase 自身的注册限流;
  // 而产品又明确不要邮箱验证 —— 两者叠加等于门口没人看着,
  // 一个脚本可以无限刷号。按来源 IP 限,数值比真人注册强度高一截。
  const ip =
    (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const limit = await checkRateLimit(`register:${ip}`, REGISTER_LIMITS);
  if (!limit.allowed) {
    return { error: limit.reason ?? "注册过于频繁,请稍后再试。" };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return {
      error: "认证服务未完整配置,当前无法注册。",
      hint: "缺少 service role 密钥,请联系管理员。",
    };
  }

  // 建号。email_confirm: true 表示直接标记为已确认,不触发任何邮件。
  const { data: createdUser, error: createError } =
    await admin.auth.admin.createUser({
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

  // 自动建一个个人组织。
  //
  // 「组织」是权限与计费的容器,数据模型上必须有。但对一个刚注册的个人用户来说,
  // 一进门就被要求填「组织名称」「组织标识」是纯粹的门槛 —— 他想用的是 AI 助手,
  // 不是来做组织管理的。此前的实际表现:注册完进去,今日页是一张创建组织表单,
  // AI 助手页写着「需要先创建组织」,工作区也一样,整个产品都是锁的。
  //
  // 所以这里替他建好。名字用邮箱前缀,标识用不会撞车的随机后缀。
  // 用户之后想改名随时可以改,但不该在第一步就被卡住。
  //
  // 失败不阻断注册:账号已经建好了,让他进去看到「需要先创建组织」
  // 也比在注册页报一个他无法理解的错误好 —— 前者还能自己动手,后者是死路。
  if (createdUser?.user?.id) {
    await createPersonalOrganization(admin, email, createdUser.user.id);
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

/**
 * 给新用户建一个个人组织并把他设为 owner。
 *
 * 走 service role 而不是用户身份客户端:此刻会话 Cookie 刚写进响应、
 * 还没回到浏览器,服务端这一侧拿不到已登录的用户身份 ——
 * 用用户身份客户端会被 RLS 挡下。
 *
 * 这是 service role 的正当用途:用户身份客户端在这个时点确实做不到。
 * 范围也严格限定 —— 只建一个组织、只给这一个用户一条成员关系。
 */
async function createPersonalOrganization(
  admin: SupabaseClient,
  email: string,
  userId: string,
): Promise<void> {
  const local = email.split("@")[0] ?? "user";
  // 组织标识只允许小写字母、数字、连字符。邮箱前缀里可能有点和加号,
  // 而且不同邮箱可能撞出同一个前缀 —— 带一个随机后缀避开唯一约束冲突。
  const base = local.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
  const slug = `${base || "user"}-${randomUUID().slice(0, 6)}`;

  const { data: org, error } = await admin
    .from("organizations")
    .insert({
      name: `${local} 的空间`,
      slug,
      // organizations.created_by 是 NOT NULL(迁移 0001)。
      // 上一版漏了这个字段,于是每次注册都撞 23502、走进下面的 error 分支
      // 静默返回 —— 「新用户注册即可用」这个功能从来没有生效过,
      // 而且因为失败被设计成不阻断注册,没有任何用户可见的迹象。
      created_by: userId,
    })
    .select("id")
    .single();

  if (error || !org) {
    logger.error({ dbError: error?.message, slug }, "自动创建个人组织失败");
    return;
  }

  // user id 直接来自 createUser 的返回值。
  //
  // 上一版是调 listUsers() 再按邮箱找 —— 那个接口默认每页 50 条,
  // 平台用户超过 50 之后新用户就不在第一页里,找不到 → 不建成员关系,
  // 而且那条分支不回滚已建的组织,库里会留下一个谁都看不见的孤儿组织。
  // createUser 本来就返回 user.id,根本不必去翻全站用户表。
  const { error: memberError } = await admin.from("memberships").insert({
    organization_id: org.id,
    user_id: userId,
    role: "owner",
    status: "active",
  });

  if (memberError) {
    // 留下一个谁都看不见的组织比没有更糟 —— 回滚
    await admin.from("organizations").delete().eq("id", org.id);
    logger.error({ dbError: memberError.message }, "自动建立成员关系失败,已回滚");
  }
}
