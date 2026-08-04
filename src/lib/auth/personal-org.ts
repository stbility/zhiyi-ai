import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCurrentUser } from "@/lib/supabase/server";
import { logger } from "@/lib/log";

/**
 * 个人组织的建立与自愈。
 *
 * 「组织」是权限与计费的容器,数据模型上必须有。但对刚注册的个人用户来说,
 * 一进门就被要求填「组织名称」「组织标识」是纯粹的门槛 —— 他想用的是 AI 助手,
 * 不是来做组织管理的。所以替他建好。
 *
 * 【为什么需要"自愈"而不只是注册时建一次】
 *
 * 生产库里的真实情况(2026-08-04 查):4 个用户,只有 2 条成员关系。
 * 中间那两个用户注册在 created_by 那个 NOT NULL 漏写字段的窗口期里,
 * 建组织静默失败,他们**至今登录进去什么都做不了**。
 *
 * 后来 bug 修好了,新注册正常 —— 但那两个人永远好不了,因为修复只作用于
 * "接下来注册的人"。一次性回填能救他们这一次,却救不了下一次:
 * 只要建组织这一步再出任何故障(数据库抖动、约束变更、限流),
 * 又会产生新的孤儿,而且同样没有任何用户可见的迹象。
 *
 * 所以放在读取路径上自愈:**发现没有组织就当场补建**。
 * 它同时修好了历史孤儿和未来可能出现的孤儿,不需要任何人去跑脚本。
 */

/**
 * 组织标识。
 *
 * 约束是 ^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$(迁移 0001)——
 * **必须以字母或数字开头和结尾**,不只是「只含小写字母数字连字符」。
 * 早先只做字符替换就直接用,于是 `-foo@x.com` 得到 `-foo-abc123`、
 * `___@x.com` 得到 `----abc123`,两者都以连字符开头,插入时撞 CHECK,
 * 自动建组织再次静默失败。
 *
 * 【后缀改成从 userId 派生,不再随机】
 *
 * 这一条是自愈的幂等保证。两个并发请求同时发现"没有组织"时,
 * 随机后缀会让它们各建一个,用户凭空多出一个组织;
 * 而确定后缀会让第二个撞上 organizations_slug_key(UNIQUE),
 * 插入失败 —— 调用方重查一次就拿到第一个建好的那个。
 * 用数据库已有的唯一约束做互斥,不必自己加锁。
 */
export function personalOrgSlug(email: string, userId: string): string {
  const local = email.split("@")[0] ?? "user";
  const base = local
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  // uuid 去掉连字符后全是十六进制,永远以字母数字结尾,满足 CHECK 的尾部要求
  const suffix = userId.replace(/-/g, "").slice(0, 8);
  return `${base || "user"}-${suffix}`;
}

/**
 * 建一个个人组织并把用户设为 owner。成功返回组织 id,失败返回 null。
 *
 * 走 service role 而不是用户身份客户端:注册那条路上,会话 Cookie 刚写进
 * 响应、还没回到浏览器,服务端拿不到已登录身份,用用户身份客户端会被 RLS 挡下。
 *
 * 这是 service role 的正当用途,范围也严格限定 ——
 * 只建一个组织、只给这一个用户一条成员关系。
 */
export async function createPersonalOrganization(
  admin: SupabaseClient,
  email: string,
  userId: string,
): Promise<string | null> {
  const local = email.split("@")[0] ?? "user";
  const slug = personalOrgSlug(email, userId);

  const { data: org, error } = await admin
    .from("organizations")
    .insert({
      name: `${local} 的空间`,
      slug,
      // organizations.created_by 是 NOT NULL(迁移 0001)。
      // 早先漏了这个字段,于是每次注册都撞 23502、走进下面的 error 分支
      // 静默返回 —— 「新用户注册即可用」从来没有生效过。
      created_by: userId,
    })
    .select("id")
    .single();

  if (error || !org) {
    logger.error({ dbError: error?.message, slug }, "创建个人组织失败");
    return null;
  }

  // user id 直接来自调用方,不去翻全站用户表 ——
  // listUsers() 默认每页 50 条,平台用户超过 50 之后新用户就不在第一页里。
  const { error: memberError } = await admin.from("memberships").insert({
    organization_id: org.id,
    user_id: userId,
    role: "owner",
    status: "active",
  });

  if (memberError) {
    // 留下一个谁都看不见的组织比没有更糟 —— 回滚
    await admin.from("organizations").delete().eq("id", org.id as string);
    logger.error({ dbError: memberError.message }, "建立成员关系失败,已回滚");
    return null;
  }

  return org.id as string;
}

/**
 * 当前登录用户如果一个组织都没有,就当场补建一个。
 *
 * 返回 true 表示这次确实补建了(调用方据此重查一遍)。
 *
 * 只在**确认为空**时才做事:正常用户每次都会走到这里,多一次判断的成本
 * 必须近似为零。所以先用一次 count 查询确认,再决定要不要动手。
 */
export async function ensurePersonalOrganization(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user?.email) return false;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    // 没有 service role 就补建不了。如实记一笔 —— 静默返回会让
    // 「用户进去是空的」变成一个查不出原因的现象
    logger.warn({ userId: user.id }, "未配置 service role,无法补建个人组织");
    return false;
  }

  // 用 admin 查而不是用户身份客户端:调用这里的前提正是
  // 「用户身份那一侧查出来是空的」,再查一遍同样的东西没有意义。
  // service role 绕过 RLS,所以必须显式按 user_id 收窄。
  const { data: existing } = await admin
    .from("memberships")
    .select("organization_id")
    .eq("user_id", user.id)
    .eq("status", "active")
    .limit(1);

  if (existing && existing.length > 0) {
    // 用户身份查不到、admin 查得到 —— 这是 RLS 策略的问题,不是没有组织。
    // 补建只会凭空多一个组织,把真正的故障盖住。
    logger.warn(
      { userId: user.id },
      "用户身份查不到成员关系但 admin 查得到 —— 疑似 RLS 策略问题,未补建",
    );
    return false;
  }

  const orgId = await createPersonalOrganization(admin, user.email, user.id);
  if (!orgId) return false;

  logger.info(
    { userId: user.id, organizationId: orgId },
    "补建个人组织成功(注册时未能建立)",
  );
  return true;
}
