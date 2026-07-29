import type { Metadata } from "next";
import Link from "next/link";

import { ChatPanel, type ModelOption } from "@/components/app/ChatPanel";
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

export default async function AssistantPage() {
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

  const models = await loadModels(org.id);

  return (
    // 对话页占满整屏:页面本身不滚动,只有消息区滚动。
    // 原先是 mx-auto max-w-5xl + 页面整体滚动,两侧留白吃掉大量横向空间,
    // 长回复还要跟着页面一起滚 —— 屏幕再大也显得局促。
    <div className="flex h-full w-full flex-col overflow-hidden px-4 py-4 md:px-6 md:py-5">
      {/* 标题压到一行,把纵向空间让给对话本身 */}
      <header className="mb-3 flex shrink-0 items-baseline gap-3">
        <h2 className="text-fg text-h3 font-zh font-semibold">AI 助手</h2>
        <p className="text-fg-tertiary font-zh text-label hidden sm:block">
          回复由你配置的模型真实生成,耗时与 token 用量如实记录
        </p>
      </header>

      <div className="min-h-0 flex-1">
        <ChatPanel models={models} />
      </div>
    </div>
  );
}
