import type { Metadata } from "next";
import Link from "next/link";

import {
  ChatPanel,
  type ConversationSummary,
  type InitialTurn,
  type ModelOption,
} from "@/components/app/ChatPanel";
import { getMyOrganizations } from "@/lib/db/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "AI 助手 · 智一 AI" };
export const dynamic = "force-dynamic";

async function loadModels(organizationId: string): Promise<ModelOption[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const { data } = await supabase
    .from("ai_models")
    .select("model_id, provider_id, ai_providers (display_name, enabled)")
    .eq("organization_id", organizationId)
    .eq("enabled", true)
    // 实际调用过、确认不能对话的模型不再出现在选择列表里
    .is("chat_unavailable_reason", null)
    .order("model_id");

  return (data ?? []).flatMap((row) => {
    const provider = row.ai_providers as unknown as {
      display_name: string;
      enabled: boolean;
    } | null;
    if (!provider || provider.enabled === false) return [];

    const providerId = row.provider_id as string;
    const modelId = row.model_id as string;
    return [
      {
        providerId,
        providerName: provider.display_name,
        modelId,
        value: `${providerId}::${modelId}`,
      },
    ];
  });
}

/**
 * 历史对话列表。
 *
 * 对话和消息一直都在库里,只是页面从不读取 —— 关掉标签页就等于全丢。
 * 这对「长期使用」是致命的:用户没法接着昨天的思路继续,也无法回看
 * 模型当时到底说了什么。
 */
async function loadConversations(
  organizationId: string,
): Promise<ConversationSummary[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  // RLS 已限定只能读到自己的对话,这里不必再按 user_id 过滤
  const { data } = await supabase
    .from("conversations")
    .select("id, title, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(50);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    title: (row.title as string | null) ?? "未命名对话",
    createdAt: row.created_at as string,
  }));
}

/** 某个对话的全部消息,用于恢复现场 */
async function loadTurns(conversationId: string): Promise<InitialTurn[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const { data } = await supabase
    .from("messages")
    .select("id, role, content, input_tokens, output_tokens, latency_ms, error_message")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  return (data ?? []).map((row) => ({
    id: row.id as string,
    role: row.role as "user" | "assistant",
    content: (row.content as string | null) ?? "",
    inputTokens: (row.input_tokens as number | null) ?? null,
    outputTokens: (row.output_tokens as number | null) ?? null,
    latencyMs: (row.latency_ms as number | null) ?? null,
    error: (row.error_message as string | null) ?? null,
  }));
}

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const organizations = await getMyOrganizations();
  const org = organizations[0];

  if (!org) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">AI 助手</h2>
        <p className="text-fg-secondary font-zh text-caption">
          需要先创建组织。模型服务与对话记录都归属于组织。
        </p>
        <Link
          href="/today"
          className="text-brand hover:text-brand-hover font-zh text-caption mt-3 inline-block"
        >
          前往创建组织
        </Link>
      </div>
    );
  }

  const [models, conversations] = await Promise.all([
    loadModels(org.id),
    loadConversations(org.id),
  ]);

  // 打开指定对话;没指定就接着最近一次继续 —— 用户回来通常是想接着上次说。
  // c=new 表示明确要开新的,此时不能回落到最近一条,否则「新对话」等于没反应。
  const requested = (await searchParams).c;
  const active =
    requested === "new"
      ? null
      : (conversations.find((c) => c.id === requested) ??
        conversations[0] ??
        null);
  const initialTurns = active ? await loadTurns(active.id) : [];

  return (
    // 对话页占满整屏:页面本身不滚动,只有消息区滚动。
    // 原先是 mx-auto max-w-5xl + 页面整体滚动,两侧留白吃掉大量横向空间,
    // 长回复还要跟着页面一起滚 —— 屏幕再大也显得局促。
    <div className="flex h-full w-full overflow-hidden">
      <ChatPanel
        // 切换对话时直接重挂组件,由初始 state 载入新数据 ——
        // 比在 effect 里同步 state 干净,也不会引起级联渲染
        key={active?.id ?? "new"}
        models={models}
        conversations={conversations}
        activeConversationId={active?.id ?? null}
        initialTurns={initialTurns}
      />
    </div>
  );
}
