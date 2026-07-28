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
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-8 md:py-10">
      <header>
        <h2 className="text-fg text-h2 font-zh font-semibold">AI 助手</h2>
        <p className="text-fg-secondary font-zh text-caption mt-2">
          使用您自己配置的模型。每次调用的耗时与 token 用量都会如实记录。
        </p>
      </header>

      <div className="min-h-0 flex-1">
        <ChatPanel models={models} />
      </div>
    </div>
  );
}
