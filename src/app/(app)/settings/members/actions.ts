"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export interface MemberActionResult {
  readonly ok?: string;
  readonly error?: string;
}

const orgSchema = z.object({
  organizationId: z.string().uuid("组织标识无效"),
});

const emailSchema = z.string().trim().email("邮箱格式不正确").max(320);

const roleSchema = z.enum(["member", "admin"]);

const memberIdSchema = z.string().uuid("成员标识无效");

/**
 * 邀请成员加入组织(阶段 2 成员管理,2026-08-11)。
 *
 * 按邮箱写入 memberships(status='invited')。用户首次登录时由
 * ensurePersonalOrganization 路径处理 —— 这里只建成员关系。
 *
 * 权限:RLS 的 memberships_insert_admin 策略只允许 owner/admin 邀请;
 * 非管理员 insert 会 42501,如实提示。
 *
 * 注意:当前实现是「直接建成员关系」,未发邮件通知 —— 邮件服务未接入
 * (status.json embeddings/email 未配置)。诚实边界:不假装发了邀请信。
 */
export async function inviteMember(
  _prev: unknown,
  formData: FormData,
): Promise<MemberActionResult> {
  const orgParsed = orgSchema.safeParse({
    organizationId: formData.get("organizationId"),
  });
  if (!orgParsed.success) {
    return { error: orgParsed.error.issues[0]?.message ?? "参数不合法" };
  }
  const emailParsed = emailSchema.safeParse(formData.get("email"));
  if (!emailParsed.success) {
    return { error: emailParsed.error.issues[0]?.message ?? "邮箱格式不正确" };
  }
  const roleParsed = roleSchema.safeParse(formData.get("role") ?? "member");
  if (!roleParsed.success) {
    return { error: "角色不合法" };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "登录状态已失效,请重新登录。" };

  // 先确认当前用户是该组织的 owner/admin —— 非管理员直接拒绝,
  // 不进入下面的 admin 查询(防止用邀请动作枚举全站邮箱是否注册)。
  const { data: myMembership } = await supabase
    .from("memberships")
    .select("role")
    .eq("organization_id", orgParsed.data.organizationId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (
    !myMembership ||
    (myMembership.role !== "owner" && myMembership.role !== "admin")
  ) {
    return { error: "只有组织所有者或管理员可以邀请成员。" };
  }

  // 邀请对象必须已注册 —— 通过 auth.users 查邮箱对应的 user_id。
  // profiles 表没有 email 列(0001 schema:id/display_name/avatar_url/locale),
  // email 只存在于 auth.users;用户身份客户端读不到 auth.users(RLS),
  // 这里用 service role 客户端的 admin.listUsers 只读解析 email → user_id
  // (PostgREST 不暴露 auth schema,与 webhook 归属解析同一模式)。
  const admin = createSupabaseAdminClient();
  if (!admin) return { error: "认证服务未配置,暂时无法邀请。" };

  const targetEmail = emailParsed.data.toLowerCase();
  let invitedUserId: string | null = null;
  for (let page = 1; page <= 50; page++) {
    const { data } = await admin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    const users = data?.users ?? [];
    const match =
      users.find((u) => u.email?.toLowerCase() === targetEmail) ?? null;
    if (match) {
      invitedUserId = match.id;
      break;
    }
    if (users.length < 1000) break;
  }

  if (!invitedUserId) {
    return {
      error: "该邮箱尚未注册智一 AI,请先让对方注册后再邀请。",
    };
  }

  const { error } = await supabase.from("memberships").insert({
    organization_id: orgParsed.data.organizationId,
    user_id: invitedUserId,
    role: roleParsed.data,
    status: "active",
  });

  if (error) {
    if (error.code === "42501") {
      return { error: "只有组织所有者或管理员可以邀请成员。" };
    }
    if (error.code === "23505") {
      return { error: "该用户已是组织成员。" };
    }
    return { error: `邀请失败:${error.message}` };
  }

  revalidatePath("/settings/members");
  return { ok: `已邀请 ${emailParsed.data} 加入组织。` };
}

/**
 * 读取「操作者」在组织内的 active 成员身份。null 表示未登录/非成员/查询失败。
 * 供 updateMemberRole / removeMember 共用:先确认操作者身份,再读取目标行。
 */
async function getMyActiveRole(
  supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>,
  organizationId: string,
  userId: string,
): Promise<"owner" | "admin" | "member" | "viewer" | null> {
  const { data, error } = await supabase
    .from("memberships")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error || !data) return null;
  return data.role as "owner" | "admin" | "member" | "viewer";
}

/**
 * 读取目标成员行(organization_id/user_id/role/status)。
 * null 表示目标不存在(可能已被移除)。
 */
async function getTargetMembership(
  supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>,
  memberId: string,
): Promise<{
  organization_id: string;
  user_id: string;
  role: string;
  status: string;
} | null> {
  const { data, error } = await supabase
    .from("memberships")
    .select("organization_id, user_id, role, status")
    .eq("id", memberId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/**
 * 修改成员角色(owner/admin 可操作)。
 *
 * 服务端强制边界(与 UI 隐藏按钮无关,防伪造请求):
 * 1. 非 owner/admin → 拒绝
 * 2. 目标必须是 active 成员(已移除/非 active 行不可改)
 * 3. owner 不得修改自己的 role(组织不能失去唯一 owner,防锁死)
 * 4. admin 不得修改 owner 的 role(owner 只能由 owner 自己保持)
 */
export async function updateMemberRole(
  memberId: string,
  role: "member" | "admin",
): Promise<MemberActionResult> {
  const idParsed = memberIdSchema.safeParse(memberId);
  if (!idParsed.success) {
    return { error: idParsed.error.issues[0]?.message ?? "参数不合法" };
  }
  const roleParsed = roleSchema.safeParse(role);
  if (!roleParsed.success) {
    return { error: "角色不合法" };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "登录状态已失效,请重新登录。" };

  const target = await getTargetMembership(supabase, idParsed.data);
  if (!target) return { error: "该成员不存在或已被移除。" };
  if (target.status !== "active") {
    return { error: "该成员状态不是已激活,无法修改角色。" };
  }

  const myRole = await getMyActiveRole(supabase, target.organization_id, user.id);
  if (myRole !== "owner" && myRole !== "admin") {
    return { error: "只有组织所有者或管理员可以修改角色。" };
  }

  // 目标保护:owner 行不可由任何人(含 owner 自己)通过此动作改角色
  if (target.role === "owner") {
    return { error: "所有者角色不可修改。" };
  }

  const { error } = await supabase
    .from("memberships")
    .update({ role: roleParsed.data })
    .eq("id", idParsed.data);

  if (error) {
    if (error.code === "42501") {
      return { error: "只有组织所有者或管理员可以修改角色。" };
    }
    return { error: `修改失败:${error.message}` };
  }

  revalidatePath("/settings/members");
  return { ok: "角色已更新。" };
}

/**
 * 移除成员(owner/admin 可操作)。
 *
 * 服务端强制边界(与 UI 隐藏按钮无关,防伪造请求):
 * 1. 非 owner/admin → 拒绝
 * 2. 目标必须是 active 成员
 * 3. owner 不得删除自己(组织不能失去唯一 owner,防锁死)
 * 4. admin 不得删除 owner
 */
export async function removeMember(memberId: string): Promise<MemberActionResult> {
  const idParsed = memberIdSchema.safeParse(memberId);
  if (!idParsed.success) {
    return { error: idParsed.error.issues[0]?.message ?? "参数不合法" };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "登录状态已失效,请重新登录。" };

  const target = await getTargetMembership(supabase, idParsed.data);
  if (!target) return { error: "该成员不存在或已被移除。" };
  if (target.status !== "active") {
    return { error: "该成员状态不是已激活,无法移除。" };
  }

  const myRole = await getMyActiveRole(supabase, target.organization_id, user.id);
  if (myRole !== "owner" && myRole !== "admin") {
    return { error: "只有组织所有者或管理员可以移除成员。" };
  }

  // 目标保护:owner 行不可被删除(owner 自己也不能,防组织失去 owner 锁死)
  if (target.role === "owner") {
    return { error: "所有者成员不可移除。" };
  }

  const { error } = await supabase
    .from("memberships")
    .delete()
    .eq("id", idParsed.data);

  if (error) {
    if (error.code === "42501") {
      return { error: "只有组织所有者或管理员可以移除成员。" };
    }
    return { error: `移除失败:${error.message}` };
  }

  revalidatePath("/settings/members");
  return { ok: "成员已移除。" };
}
