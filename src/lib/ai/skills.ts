import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * SKILL 技能引擎 —— 对齐 Hermes Agent 的 SKILL.md 规范。
 *
 * Hermes 的技能是一堆 SKILL.md 文件(文件系统),zhiyi-ai 的技能是
 * skills 表 + skill_files 表(数据库)。结构一致:
 *
 *   skills.name        → Hermes 的 frontmatter name (slug)
 *   skills.description → Hermes 的 frontmatter description (触发条件)
 *   skills.body        → Hermes 的 SKILL.md 正文(frontmatter 之后)
 *   skill_files        → Hermes 的 linked_files (references/templates/scripts)
 *
 * 与 Hermes 相同的加载哲学:**只展示索引,正文按需加载**。
 * 模型先看到「有哪些技能 + 一句话描述」(skill_list),判断哪个相关,
 * 再 skill_view 加载正文。五十个技能全塞进上下文会撑爆预算;
 * 一次只加载用得到的那一个。
 *
 * 数据访问走 service_role(无 RLS 兜底),所以**每个查询都必须显式
 * 带 organization_id** —— 与 mcp/tools.ts 同一条纪律,漏一处就是跨组织泄露。
 */

export interface SkillSummary {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly tags: readonly string[];
}

export interface SkillDetail extends SkillSummary {
  readonly body: string;
  readonly relatedSkills: readonly string[];
  readonly files: readonly { path: string; content: string }[];
}

/** skill_list:列出组织里启用的技能,只给索引字段 */
export async function listSkills(
  organizationId: string,
): Promise<SkillSummary[]> {
  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  const { data } = await admin
    .from("skills")
    .select("name, title, description, version, tags")
    .eq("organization_id", organizationId)
    .eq("enabled", true)
    .order("name");

  return (data ?? []).map((row) => ({
    name: row.name as string,
    title: row.title as string,
    description: row.description as string,
    version: row.version as string,
    tags: (row.tags as string[] | null) ?? [],
  }));
}

/** skill_view:加载一个技能全文 + 附件。找不到返回 null */
export async function loadSkill(
  organizationId: string,
  name: string,
): Promise<SkillDetail | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data: skill } = await admin
    .from("skills")
    .select(
      "id, name, title, description, version, tags, related_skills, body, enabled",
    )
    .eq("organization_id", organizationId)
    .eq("name", name)
    .maybeSingle();

  if (!skill || skill.enabled !== true) return null;

  const { data: files } = await admin
    .from("skill_files")
    .select("path, content")
    .eq("skill_id", skill.id)
    .order("path");

  return {
    name: skill.name as string,
    title: skill.title as string,
    description: skill.description as string,
    version: skill.version as string,
    tags: (skill.tags as string[] | null) ?? [],
    relatedSkills: (skill.related_skills as string[] | null) ?? [],
    body: skill.body as string,
    files: (files ?? []).map((f) => ({
      path: f.path as string,
      content: f.content as string,
    })),
  };
}

// 纯解析/序列化在 skill-markdown.ts(无 server-only,测试可直接导入);
// 本模块只负责数据库侧。公共 API 保持不变。
export {
  buildSkillMarkdown,
  isValidSkillName,
  parseSkillMarkdown,
  SkillParseError,
  type ParsedSkill,
  type SkillDraft,
} from "@/lib/ai/skill-markdown";
