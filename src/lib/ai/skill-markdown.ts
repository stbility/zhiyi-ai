/**
 * SKILL.md 纯解析/序列化 —— 无 server-only,测试可直接导入。
 *
 * 与 skills.ts 的关系:skills.ts 负责数据库(带 server-only 守卫),
 * 本模块只做 markdown ↔ 结构 的纯转换,两端共用同一把尺子。
 * 抽取原因:CI 冷启动下 server-only 抛错 —— 与 memory-content.ts 同一经验。
 */

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

/** name slug 合法性 —— 编辑器与解析器共用同一把尺子 */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-_]*$/.test(name);
}

export interface SkillDraft {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly author: string;
  readonly license: string;
  readonly platforms: readonly string[];
  readonly tags: readonly string[];
  readonly relatedSkills: readonly string[];
  readonly body: string;
}

/**
 * 编辑器的逆序列化:字段 → SKILL.md 文本。
 * 与 parseSkillMarkdown 互为逆操作(round-trip 有测试兜底),
 * 保证「页内编辑保存」和「粘贴导入」两条路产出的技能文件同构。
 */
export function buildSkillMarkdown(d: SkillDraft): string {
  const list = (v: readonly string[]) => v.join(",");
  const esc = (v: string) => v.replace(/\n/g, " ").replace(/\r/g, "");
  const frontmatter = [
    "---",
    `name: ${d.name}`,
    `title: ${esc(d.title)}`,
    `description: ${esc(d.description)}`,
    `version: ${d.version}`,
    `author: ${esc(d.author)}`,
    `license: ${d.license}`,
    `platforms: ${list(d.platforms)}`,
    `tags: ${list(d.tags)}`,
    `related_skills: ${list(d.relatedSkills)}`,
    "---",
    "",
  ].join("\n");
  return `${frontmatter}${d.body.trim()}\n`;
}
