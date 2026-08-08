import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 知识库召回(消费端)。
 *
 * 与记忆召回同一形态:agent-turn 在组装上下文时调用,把组织内
 * 最近就绪的文档正文带进任务。v1 按最近就绪取前 N 份(全文检索的
 * 关键词匹配在知识库页做;agent 侧的上下文注入先保证「有得用」,
 * 向量检索接入后这里换成相关性排序)。
 */

export interface KnowledgeHit {
  readonly id: string;
  readonly name: string;
  readonly content: string;
}

/** 单份文档注入上下文的正文上限 */
const HIT_MAX_CHARS = 1200;
/** 一次注入最多几份文档 */
const HIT_LIMIT = 3;
/** 整个知识块的总上限,防止撑爆上下文 */
const BLOCK_MAX_CHARS = 4000;

export function buildKnowledgeBlock(hits: readonly KnowledgeHit[]): string {
  if (hits.length === 0) return "";
  const lines: string[] = ["\n\n【你的知识库 —— 组织文档,回答时优先参考】"];
  let total = 0;
  for (const hit of hits) {
    const body =
      hit.content.length > HIT_MAX_CHARS
        ? `${hit.content.slice(0, HIT_MAX_CHARS)}…(截断)`
        : hit.content;
    if (total + body.length > BLOCK_MAX_CHARS) break;
    lines.push(`- 《${hit.name}》\n${body}`);
    total += body.length;
  }
  return lines.join("\n");
}

export async function recallKnowledge(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<KnowledgeHit[]> {
  const { data, error } = await supabase
    .from("knowledge_files")
    .select("id, name, content_text")
    .eq("organization_id", organizationId)
    .eq("status", "ready")
    .order("updated_at", { ascending: false })
    .limit(HIT_LIMIT);

  if (error || !data) return [];
  return (data as { id: string; name: string; content_text: string }[]).map(
    (row) => ({
      id: row.id,
      name: row.name,
      content: row.content_text ?? "",
    }),
  );
}
