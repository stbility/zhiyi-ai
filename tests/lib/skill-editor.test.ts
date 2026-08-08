import { describe, expect, it } from "vitest";

import {
  buildSkillMarkdown,
  parseSkillMarkdown,
  isValidSkillName,
} from "@/lib/ai/skills";

describe("技能编辑器的 SKILL.md 往返", () => {
  const draft = {
    name: "weekly-report",
    title: "周报生成",
    description: "Use when generating a weekly report.",
    version: "1.0.0",
    author: "",
    license: "MIT",
    platforms: ["linux", "macos", "windows"],
    tags: ["report", "weekly"],
    relatedSkills: [],
    body: "# 周报生成\n\n## 步骤\n1. 收集数据\n2. 生成报告\n",
  };

  it("buildSkillMarkdown → parseSkillMarkdown 往返无损", () => {
    const markdown = buildSkillMarkdown(draft);
    const parsed = parseSkillMarkdown(markdown);
    expect(parsed.name).toBe(draft.name);
    expect(parsed.title).toBe(draft.title);
    expect(parsed.description).toBe(draft.description);
    expect(parsed.version).toBe(draft.version);
    expect(parsed.tags).toEqual(draft.tags);
    expect(parsed.body.trim()).toBe(draft.body.trim());
  });

  it("正文含多行与中文时仍无损", () => {
    const withMultiline = {
      ...draft,
      body: "# 标题\n\n第一段:包含中文与数字 42。\n\n- 要点一\n- 要点二\n",
    };
    const markdown = buildSkillMarkdown(withMultiline);
    expect(parseSkillMarkdown(markdown).body.trim()).toBe(withMultiline.body.trim());
  });

  it("slug 校验与解析器同一把尺子", () => {
    expect(isValidSkillName("weekly-report")).toBe(true);
    expect(isValidSkillName("Weekly_Report")).toBe(false); // 大写不合法
    expect(isValidSkillName("-lead")).toBe(false); // 不能以连字符开头
    expect(isValidSkillName("a b")).toBe(false);
  });
});
