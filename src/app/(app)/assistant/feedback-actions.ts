"use server";

import { z } from "zod";

import { logDbFailure } from "@/lib/log";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 回答反馈。
 *
 * 这是反馈飞轮的入口,也是整条链路上唯一一件**现在不做以后补不回来**的事:
 * 历史对话随时能回捞,但用户当时想把这句话改成什么,过后没人记得。
 *
 * 三种判定里,edited 的价值远高于另外两种 —— 它直接给出「模型写的」
 * 和「你要的」之间的差,既是评测用例,也是将来微调的成对样本。
 */

export interface FeedbackState {
  ok?: string;
  error?: string;
}

const schema = z.object({
  messageId: z.string().uuid(),
  verdict: z.enum(["good", "bad", "edited"]),
  editedText: z.string().trim().max(100_000).optional(),
  reason: z.string().trim().max(2000).optional(),
});

export async function submitFeedback(
  _prev: FeedbackState,
  formData: FormData,
): Promise<FeedbackState> {
  const parsed = schema.safeParse({
    messageId: formData.get("messageId"),
    verdict: formData.get("verdict"),
    editedText: formData.get("editedText") || undefined,
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "输入不合法" };
  }

  // edited 却没给改法,等于什么都没说 —— 与其存一条空记录,不如当场拦下
  if (parsed.data.verdict === "edited" && !parsed.data.editedText) {
    return { error: "请填写你希望它改成什么样。" };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "登录状态已失效,请重新登录。" };

  // 组织归属取自消息本身,不采信客户端 —— 否则反馈会落到别的组织名下,
  // 而后面要用它做评测集,归属错了整批数据都不可信
  const { data: message } = await supabase
    .from("messages")
    .select("id, organization_id")
    .eq("id", parsed.data.messageId)
    .maybeSingle();

  if (!message) return { error: "找不到这条消息。" };

  const { error } = await supabase.from("message_feedback").upsert(
    {
      message_id: parsed.data.messageId,
      organization_id: message.organization_id as string,
      verdict: parsed.data.verdict,
      edited_text: parsed.data.editedText ?? null,
      reason: parsed.data.reason ?? null,
      created_by: user.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "message_id,created_by" },
  );

  if (error) {
    logDbFailure("message_feedback.upsert", error, {
      messageId: parsed.data.messageId,
    });
    return { error: `未能保存反馈:${error.message}` };
  }

  return {
    ok:
      parsed.data.verdict === "edited"
        ? "已记下你的改法 —— 这类数据最有价值,谢谢。"
        : "已记录,谢谢反馈。",
  };
}
