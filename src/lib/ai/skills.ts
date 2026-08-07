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

/**
 * 把 Hermes 的 SKILL.md 全文(frontmatter + body)解析成可入库的结构。
 *
 * 对齐 Hermes 的 frontmatter 字段:
 *   name / description / version / author / license / platforms
 *   metadata.hermes.tags / metadata.hermes.related_skills
 *
 * 用正则做轻量解析而不是引 yaml 库:frontmatter 是我们自己写的规范,
 * 字段都是标量或数组,项目对依赖克制(与 check-migrations.sh 同哲学)。
 * 解析失败时给出能照着改的错误,而不是静默返回半成品。
 */
export interface ParsedSkill {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly author: string;
  readonly license: string;
  readonly platforms: string[];
  readonly tags: string[];
  readonly relatedSkills: string[];
  readonly body: string;
}

/** 解析失败时返回的说明,让调用方能照着改 */
export class SkillParseError extends Error {}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "[]") return [];
  // 支持 [a, b, c] 或 "a", "b" 或 a, b
  return trimmed
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
}

function parseScalar(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.replace(/^["']|["']$/g, "");
}

export function parseSkillMarkdown(markdown: string): ParsedSkill {
  // frontmatter:文件头 --- ... ---
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!m) {
    throw new SkillParseError(
      "技能文件缺少 frontmatter(应以 --- 开头,内容在第二个 --- 之后)",
    );
  }
  const front = m[1] ?? "";
  const body = (m[2] ?? "").trim();

  // 逐行解析 key: value;metadata.hermes.tags 归并进 tags
  const fields = new Map<string, string>();
  let inMetadataBlock = false;
  for (const line of front.split("\n")) {
    const t = line.trim();
    if (t === "metadata:" || t === "hermes:") {
      inMetadataBlock = t === "metadata:";
      continue;
    }
    if (inMetadataBlock && t.startsWith("metadata:")) {
      inMetadataBlock = true;
      continue;
    }
    const kv = /^([\w.-]+):\s*(.*)$/.exec(t);
    if (!kv) continue;
    let key = kv[1] ?? "";
    // metadata.hermes.tags → tags;metadata.hermes.related_skills → related_skills
    if (key === "hermes.tags" || key === "tags") key = "tags";
    if (key === "hermes.related_skills" || key === "related_skills") {
      key = "related_skills";
    }
    fields.set(key, kv[2] ?? "");
  }

  const name = parseScalar(fields.get("name"));
  if (!name) {
    throw new SkillParseError("frontmatter 缺少 name(slug),如 weekly-report");
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(name)) {
    throw new SkillParseError(
      "name 必须是合法 slug(小写字母/数字/连字符/下划线)",
    );
  }

  const description = parseScalar(fields.get("description"));
  if (!description) {
    throw new SkillParseError(
      "frontmatter 缺少 description —— 它决定 agent 何时加载这个技能",
    );
  }

  return {
    name,
    title: parseScalar(fields.get("title")) ?? name,
    description,
    version: parseScalar(fields.get("version")) ?? "1.0.0",
    author: parseScalar(fields.get("author")) ?? "",
    license: parseScalar(fields.get("license")) ?? "MIT",
    platforms: parseList(fields.get("platforms")),
    tags: parseList(fields.get("tags")),
    relatedSkills: parseList(fields.get("related_skills")),
    body,
  };
}
