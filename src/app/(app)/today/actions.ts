"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 创建组织。
 *
 * 输入一律经 Zod 校验后才落库 —— 不信任任何来自表单的内容。
 * 数据库侧另有 CHECK 约束与 RLS 兜底,即便这里被绕过也不会写入非法数据。
 *
 * 创建组织与建立成员关系必须一起成功:只建了组织却没有成员关系,
 * 会因 RLS 导致创建者立刻看不见自己刚建的组织。单次 REST 调用无法做跨表事务,
 * 因此这里在成员关系失败时显式回滚已创建的组织。
 */

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "请输入组织名称")
    .max(100, "组织名称不能超过 100 个字符"),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/,
      "标识只能用小写字母、数字与连字符,长度 3–50",
    ),
});

export interface CreateOrganizationState {
  readonly error?: string;
}

export async function createOrganization(
  _prev: CreateOrganizationState,
  formData: FormData,
): Promise<CreateOrganizationState> {
  const parsed = schema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "输入不合法" };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置,无法创建组织。" };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "登录状态已失效,请重新登录。" };

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .insert({
      name: parsed.data.name,
      slug: parsed.data.slug,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (orgError || !org) {
    if (orgError?.code === "23505") {
      return { error: "该组织标识已被占用,请换一个。" };
    }
    return { error: orgError?.message ?? "创建组织失败。" };
  }

  const orgId = org.id as string;

  const { error: memberError } = await supabase.from("memberships").insert({
    organization_id: orgId,
    user_id: user.id,
    role: "owner",
    status: "active",
  });

  if (memberError) {
    // 回滚:留下一个自己都看不见的组织,比直接失败更糟
    await supabase.from("organizations").delete().eq("id", orgId);
    return { error: "建立成员关系失败,已撤销本次创建。" };
  }

  // 审计记录由数据库触发器 organizations_audit_create 写入,应用层不参与:
  // 客户端若能自由写审计表就能伪造轨迹,因此 audit_logs 没有面向用户的 INSERT 策略。

  revalidatePath("/today");
  return {};
}
