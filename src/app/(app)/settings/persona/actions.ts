"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";

const personaSchema = z.object({
  organizationId: z.string().uuid(),
  persona: z
    .string()
    .trim()
    .max(2000, "品牌人格最多 2000 字"),
});

export type PersonaActionState = {
  ok: boolean;
  message: string;
};

/**
 * 保存组织品牌人格(P3,2026-08-11)。
 *
 * 写入 organizations.persona(0054 迁移加列)。RLS:organizations_update_admin
 * 策略只允许 owner/admin 改 —— 非管理员更新会返回 42501,如实提示。
 */
export async function savePersona(
  _prev: PersonaActionState,
  formData: FormData,
): Promise<PersonaActionState> {
  const parsed = personaSchema.safeParse({
    organizationId: formData.get("organizationId"),
    persona: formData.get("persona"),
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "参数不合法" };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "服务端 Supabase 客户端不可用" };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "请先登录" };

  const persona = parsed.data.persona === "" ? null : parsed.data.persona;
  const { error } = await supabase
    .from("organizations")
    .update({ persona })
    .eq("id", parsed.data.organizationId);

  if (error) {
    if (error.code === "42501") {
      return { ok: false, message: "只有组织管理员或所有者可以修改品牌人格" };
    }
    return { ok: false, message: `保存失败:${error.message}` };
  }

  revalidatePath("/settings/persona");
  return { ok: true, message: "品牌人格已保存,新的智能体运行将生效" };
}
