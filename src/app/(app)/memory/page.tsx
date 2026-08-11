import type { Metadata } from "next";

import { MemoryManager, type MemoryRow } from "@/components/app/MemoryManager";
import type { MemorySource } from "@/components/memory/MemorySourceBadge";
import { getMyOrganizations } from "@/lib/db/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "AI 记忆 · 智一 AI" };
export const dynamic = "force-dynamic";

const CATEGORY_LABEL: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  convention: "约定",
  knowledge: "知识",
  persona: "人设",
};

/** DB source_type → 设计系统 MemorySource(枚举不得含糊或合并) */
const SOURCE_MAP: Record<string, MemorySource> = {
  user_confirmed: "confirmed",
  ai_inferred: "inferred",
  from_file: "file",
  from_workflow: "workflow",
};

async function loadMemories(
  organizationId: string,
): Promise<MemoryRow[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  // RLS(0028)已限定:组织成员可见(组织级记忆 + 自己的用户级记忆)。
  // 服务端不再按 scope 过滤 —— 数据库的判定就是最终判定,这里只取列。
  const { data } = await supabase
    .from("memories")
    .select(
      "id, category, content, source_type, confidence, recall_enabled, last_used_at, created_at, created_by",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  return (data ?? []).map((row) => ({
    id: row.id as string,
    categoryLabel: CATEGORY_LABEL[(row.category as string) ?? "fact"] ?? "其他",
    content: row.content as string,
    source: SOURCE_MAP[(row.source_type as string) ?? "ai_inferred"] ?? "inferred",
    confidence: (row.confidence as number | null) ?? null,
    recallEnabled: (row.recall_enabled as boolean) ?? true,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    createdAt: row.created_at as string,
    mine: (row.created_by as string) === user.id,
  }));
}

export default async function MemoryPage() {
  const organizations = await getMyOrganizations();
  const org = organizations[0];

  if (!org) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">AI 记忆</h2>
        <p className="text-fg-secondary font-zh text-caption">
          需要先创建组织。记忆归属于组织。
        </p>
      </div>
    );
  }

  const memories = await loadMemories(org.id);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-8 md:py-10">
      <header>
        <h2 className="text-fg text-h2 font-zh font-semibold">AI 记忆</h2>
        <p className="text-fg-secondary font-zh text-caption mt-2">
          智能体沉淀的长期事实与偏好。来源如实标注:用户确认的与 AI 推断的分开显示,绝不伪装。
          召回开关与删除仅对本人创建的记忆可用。
        </p>
      </header>

      <MemoryManager memories={memories} />
    </div>
  );
}
