import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 反馈飞轮消费端:message_feedback.edited → eval_cases。
 *
 * 核心洞察(feedback-actions.ts 的注释):edited 的价值远高于 good/bad ——
 * 它直接给出「模型写的」和「你要的」之间的差。把差提取成判定标准,
 * 就是评测用例,也是将来微调的成对样本。
 *
 * 提取策略(诚实边界):中文按标点切段,取「原文没有、改写里才有」的
 * 段落作为 mustContainAny —— 模型重答时命中了这些段落,才算理解
 * 用户想要什么。纯风格改动(没有新增信息段)不生成用例:没有可判定的
 * 标准,硬生成只会是噪声。
 */

// 全角 + 半角标点都切 —— 真实用户改写里两种都有
const SEGMENT_SPLIT = /[，。！？；、,.;:!?\n\r]+/;
const MIN_SEGMENT_CHARS = 6;
const MAX_CRITERIA = 3;

/** 提取「改写里新增的信息段」。纯函数,可单测。 */
export function extractCorrectionPhrases(original: string, edited: string): string[] {
  const phrases = edited
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SEGMENT_CHARS)
    .filter((s) => !original.includes(s));
  return phrases.slice(0, MAX_CRITERIA);
}

export interface SyncResult {
  readonly created: number;
  readonly skipped: number;
  readonly total: number;
}

/**
 * 把当前用户「改写过的反馈」同步为评测用例。
 * 幂等:同一反馈只生成一次(key = fb_<feedback_id>)。
 */
export async function syncFeedbackToEvalCases(
  supabase: SupabaseClient,
  userId: string,
): Promise<SyncResult> {
  const { data: feedbacks, error } = await supabase
    .from("message_feedback")
    .select(
      "id, edited_text, message_id, messages!inner(conversation_id, content, created_at)",
    )
    .eq("created_by", userId)
    .eq("verdict", "edited")
    .not("edited_text", "is", null)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return { created: 0, skipped: 0, total: 0 };

  let created = 0;
  let skipped = 0;

  for (const fb of (feedbacks ?? []) as unknown[]) {
    const row = fb as {
      id: string;
      edited_text: string;
      messages: { conversation_id: string; content: string; created_at: string };
    };
    const original = row.messages?.content ?? "";
    const edited = row.edited_text ?? "";
    if (!original || !edited) {
      skipped += 1;
      continue;
    }

    // 同会话里这条消息之前最近的 user 消息 = 触发原回答的问题
    const { data: promptRows } = await supabase
      .from("messages")
      .select("content")
      .eq("conversation_id", row.messages.conversation_id)
      .eq("role", "user")
      .lt("created_at", row.messages.created_at)
      .order("created_at", { ascending: false })
      .limit(1);
    const prompt = (promptRows?.[0] as { content?: string } | undefined)?.content;

    const criteria = extractCorrectionPhrases(original, edited);
    if (!prompt || criteria.length === 0) {
      // 没有可判定的标准,硬生成只会是噪声
      skipped += 1;
      continue;
    }

    const { error: insertError } = await supabase.from("eval_cases").insert({
      key: `fb_${row.id}`,
      name: `来自反馈改写 #${row.id.slice(0, 8)}`,
      prompt,
      must_contain: [],
      must_contain_any: criteria,
      must_not_contain: [],
      timeout_ms: 25_000,
      source: "feedback",
      feedback_id: row.id,
      created_by: userId,
    });
    if (insertError) skipped += 1;
    else created += 1;
  }

  return { created, skipped, total: created + skipped };
}
