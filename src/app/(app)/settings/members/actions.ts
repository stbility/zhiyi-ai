"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface MemberActionResult {
  readonly ok?: string;
  readonly error?: string;
}

const orgSchema = z.object({
  organizationId: z.string().uuid("组织标识无效"),
});

const emailSchema = z.string().trim().email("邮箱格式不正确").max(320);

const roleSchema = z.enum(["member", "admin"]);

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
  const orgParsed = orgSchema.safeParse(formData.get("organizationId"));
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

  // 邀请对象必须已注册 —— 通过 auth.users 查邮箱对应的 user_id
  const { data: invitedUser } = await supabase
    .from("profiles")
    .select("id, email")
    .eq("email", emailParsed.data)
    .maybeSingle();

  if (!invitedUser) {
    return {
      error: "该邮箱尚未注册智一 AI,请先让对方注册后再邀请。",
    };
  }

  const { error } = await supabase.from("memberships").insert({
    organization_id: orgParsed.data.organizationId,
    user_id: invitedUser.id,
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

/** 修改成员角色(owner/admin 可操作;owner 本身不可降级,防锁死) */
export async function updateMemberRole(
  memberId: string,
  role: "member" | "admin",
): Promise<MemberActionResult> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { error } = await supabase
    .from("memberships")
    .update({ role })
    .eq("id", memberId);

  if (error) {
    if (error.code === "42501") {
      return { error: "只有组织所有者或管理员可以修改角色。" };
    }
    return { error: `修改失败:${error.message}` };
  }

  revalidatePath("/settings/members");
  return { ok: "角色已更新。" };
}

/** 移除成员(owner/admin 可操作;不能移除 owner 自身) */
export async function removeMember(memberId: string): Promise<MemberActionResult> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { error } = await supabase
    .from("memberships")
    .delete()
    .eq("id", memberId);

  if (error) {
    if (error.code === "42501") {
      return { error: "只有组织所有者或管理员可以移除成员。" };
    }
    return { error: `移除失败:${error.message}` };
  }

  revalidatePath("/settings/members");
  return { ok: "成员已移除。" };
}
