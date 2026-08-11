import type { Metadata } from "next";

import { PersonaSettingsPanel } from "@/components/settings/PersonaSettingsPanel";
import { getCurrentOrganization } from "@/lib/db/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "品牌人格 · 智一 AI" };
export const dynamic = "force-dynamic";

/**
 * 品牌人格设置(P3,2026-08-11)。
 *
 * 组织级自定义人格:组织在这里配置的语气、品牌名、专属指令会注入
 * 智能体系统提示词(agent 链路)。未配置 = 用默认人格。
 *
 * 数据落 organizations.persona(0054 迁移加列)。RLS 沿用组织既有策略:
 * 成员可读、owner/admin 可改 —— 页面只对 admin/owner 开放编辑。
 */

async function loadOrgPersona(organizationId: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return "";

  const { data } = await supabase
    .from("organizations")
    .select("persona")
    .eq("id", organizationId)
    .maybeSingle();

  return (data?.persona as string | null | undefined) ?? "";
}

export default async function PersonaPage() {
  const org = await getCurrentOrganization();

  if (!org) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">品牌人格</h2>
        <p className="text-fg-secondary font-zh text-caption">
          需要先创建组织。品牌人格归属于组织。
        </p>
      </div>
    );
  }

  const persona = await loadOrgPersona(org.id);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
      <PersonaSettingsPanel organizationId={org.id} initialPersona={persona} />
    </main>
  );
}
