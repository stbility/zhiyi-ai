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
  const { error: msgError, count: msgErrorCount } = await supabase
    .from("messages")
    .delete({ count: "exact" })
    .eq("conversation_id", parsed.data.id);
  if (msgError) return { error: msgError.message };
  // 0 行被删 = RLS 把这次操作拦下了(PostgREST 在 0 行匹配时**不返回错误**)。
  // 此前只判 error,于是越权删除会得到一句「已删除。」—— 反馈与事实相反,
  // 用户以为删掉了,刷新一看还在。
  if ((msgErrorCount ?? 0) === 0) {
    return { error: "没有权限删除,或该记录已不存在。" };
  }

  const { error, count } = await supabase
    .from("conversations")
    .delete({ count: "exact" })
    .eq("id", parsed.data.id);
  if (error) return { error: error.message };
  // 0 行被删 = RLS 把这次操作拦下了(PostgREST 在 0 行匹配时**不返回错误**)。
  // 此前只判 error,于是越权删除会得到一句「已删除。」—— 反馈与事实相反,
  // 用户以为删掉了,刷新一看还在。
  if ((count ?? 0) === 0) {
    return { error: "没有权限删除,或该记录已不存在。" };
  }

  revalidatePath("/assistant");
  return {};
}
