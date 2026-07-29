"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 对话的删除。
 *
 * 走用户身份客户端,RLS 保证只能删自己的对话 —— 不用 service role 绕过,
 * 那会让「谁能删什么」完全依赖这段代码写得对不对。
 */

const schema = z.object({ id: z.string().uuid() });

export interface AssistantActionState {
  readonly error?: string;
}

export async function deleteConversation(
  _prev: AssistantActionState,
  formData: FormData,
): Promise<AssistantActionState> {
  const parsed = schema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return { error: "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  // 先删消息再删对话。messages 若没有级联删除,先删对话会留下孤儿记录,
  // 它们占着空间又永远读不到。
  const { error: msgError } = await supabase
    .from("messages")
    .delete()
    .eq("conversation_id", parsed.data.id);
  if (msgError) return { error: msgError.message };

  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", parsed.data.id);
  if (error) return { error: error.message };

  revalidatePath("/assistant");
  return {};
}
