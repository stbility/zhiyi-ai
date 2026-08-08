import type { Metadata } from "next";
import Link from "next/link";

import { SkillsManager, type SkillRow } from "@/components/app/SkillsManager";
import { getMyOrganizations } from "@/lib/db/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "技能库 · 智一 AI" };
export const dynamic = "force-dynamic";

/**
 * 技能库页面。
 *
 * 列表 + 附件计数。技能正文只在 agent skill_view 时按需加载 ——
 * 管理页列出的是索引(名字、描述、版本),不是全文。
 * 描述就是 agent 判断「何时加载」的依据,所以它值得单独一行展示。
 */
async function loadSkills(organizationId: string): Promise<SkillRow[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const { data: skills } = await supabase
    .from("skills")
    .select("id, name, title, description, version, tags, body, enabled, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  const rows = (skills ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    title: row.title as string,
    description: row.description as string,
    version: row.version as string,
    tags: (row.tags as string[] | null) ?? [],
    body: (row.body as string | null) ?? "",
    enabled: (row.enabled as boolean | null) ?? true,
    createdAt: row.created_at as string,
  }));

  // 附件计数:一次查出全部技能的文件数,按技能分组
  const { data: files } = await supabase
    .from("skill_files")
    .select("skill_id")
    .in(
      "skill_id",
      rows.map((r) => r.id),
    );

  const counts = new Map<string, number>();
  for (const f of files ?? []) {
    const skillId = f.skill_id as string;
    counts.set(skillId, (counts.get(skillId) ?? 0) + 1);
  }

  return rows.map((r) => ({ ...r, fileCount: counts.get(r.id) ?? 0 }));
}

export default async function SkillsPage() {
  const organizations = await getMyOrganizations();
  const org = organizations[0];

  if (!org) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">技能库</h2>
        <p className="text-fg-secondary font-zh text-caption">
          需要先创建组织。技能归属于组织,而非个人账户。
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

  const skills = await loadSkills(org.id);
  // 0042 起写操作放开到组织成员 —— 技能库就是给非工程师编辑的
  const canManage = true;

  return (
    <SkillsManager
      organizationId={org.id}
      skills={skills}
      canManage={canManage}
    />
  );
}
