"use server";

import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Enterprise 询价表单提交(P0-3)。
 *
 * 「联系销售」= 站内表单,不是跳 Stripe 付款页。提交落 sales_leads 表,
 * 由销售人工跟进。created_by 在服务端绑定当前登录用户 ——
 * 不接受客户端伪造归属。
 */

export interface LeadActionState {
  readonly ok?: string;
  readonly error?: string;
}

const leadSchema = z.object({
  companyName: z.string().trim().min(1, "公司名不能为空").max(200, "公司名过长"),
  contactName: z.string().trim().min(1, "姓名不能为空").max(100, "姓名过长"),
  email: z.string().trim().email("邮箱格式不正确").max(200, "邮箱过长"),
  teamSize: z.string().trim().max(50).optional(),
  scale: z.string().trim().max(200).optional(),
  description: z.string().trim().min(10, "请至少写 10 字说明需求").max(2000, "需求描述过长"),
});

export async function submitSalesLead(
  _prev: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const parsed = leadSchema.safeParse({
    companyName: formData.get("companyName"),
    contactName: formData.get("contactName"),
    email: formData.get("email"),
    teamSize: formData.get("teamSize"),
    scale: formData.get("scale"),
    description: formData.get("description"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "输入不合法" };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { error: "认证服务未配置。" };
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: "请先登录。" };
  }

  const { error } = await supabase.from("sales_leads").insert({
    company_name: parsed.data.companyName,
    contact_name: parsed.data.contactName,
    email: parsed.data.email,
    team_size: parsed.data.teamSize ?? null,
    scale: parsed.data.scale ?? null,
    description: parsed.data.description,
    plan_id: "enterprise",
    created_by: user.id,
  });

  if (error) {
    return { error: `提交失败:${error.message}` };
  }

  return {
    ok: "已收到询价,销售团队将在 1 个工作日内通过邮件联系你。",
  };
}
