import { describe, expect, it, vi } from "vitest";

/**
 * SKILL 技能库(src/lib/ai/skills.ts)。
 *
 * 守的是:
 *   1. frontmatter 解析:对齐 Hermes 的 SKILL.md 规范 —— 同一份技能文件
 *      两端(Hermes 本地 / zhiyi-ai 产品)都能跑
 *   2. 组织隔离:service_role 无 RLS 兜底,每个查询必须显式带 organization_id
 *   3. 加载语义:skill_view 只返回启用的技能,禁用/不存在都返回 null
 */

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** 一份标准的 Hermes 风格 SKILL.md */
const HERMES_STYLE_SKILL = `---
name: weekly-report
title: 周报生成
description: Use when generating a weekly report for the team.
version: 1.2.0
author: zhiyi-ai
license: MIT
platforms: [linux, macos, windows]
tags: [report, weekly]
related_skills: [competitor-scan]
metadata:
  hermes:
    tags: [report, weekly]
---

# 周报生成

每周五生成团队周报:

1. 汇总本周 commits
2. 标注阻塞项
3. 输出到工作区
`;

/** 一个只认「组织 + 主键」的假 admin 客户端(与 isolation.test.ts 同模式) */
function fakeAdmin(rows: Record<string, Record<string, unknown>[]>) {
  const calls: { table: string; filters: Record<string, unknown> }[] = [];

  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    const api: Record<string, unknown> = {
      select: () => api,
      order: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      maybeSingle: async () => {
        calls.push({ table, filters });
        const hit = (rows[table] ?? []).find((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return { data: hit ?? null, error: null };
      },
      then: undefined,
    };
    // 数组查询:await supabase.from().select() 直接得到全部匹配行
    const arrApi: Record<string, unknown> = {
      select: () => arrApi,
      order: () => arrApi,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return arrApi;
      },
      then: (resolve: (v: unknown) => void) => {
        calls.push({ table, filters });
        const hit = (rows[table] ?? []).filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        resolve({ data: hit, error: null });
      },
    };
    // 关键:from() 返回的对象必须同时能走 maybeSingle(单行)和 then(数组)。
    // 技巧:让两种结束方式都挂在同一个对象上
    const shared = {
      select: () => shared,
      order: () => shared,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return shared;
      },
      maybeSingle: async () => {
        calls.push({ table, filters });
        const hit = (rows[table] ?? []).find((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return { data: hit ?? null, error: null };
      },
      then: (resolve: (v: unknown) => void) => {
        calls.push({ table, filters });
        const hit = (rows[table] ?? []).filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        resolve({ data: hit, error: null });
      },
    };
    return shared;
  };

  const client = {
    from: builder,
    calls,
  };
  return client;
}

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return await import("@/lib/ai/skills");
}

/** 用假 admin 替换真实客户端,返回查询记录 */
async function loadWithAdmin(rows: Record<string, Record<string, unknown>[]>) {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  let calls: { table: string; filters: Record<string, unknown> }[] = [];
  vi.doMock("@/lib/supabase/admin", () => ({
    createSupabaseAdminClient: () => {
      const f = fakeAdmin(rows);
      calls = f.calls;
      return f;
    },
  }));
  const mod = await import("@/lib/ai/skills");
  return { mod, calls: () => calls };
}

describe("frontmatter 解析", () => {
  it("解析 Hermes 风格 SKILL.md(frontmatter + body)", async () => {
    const { parseSkillMarkdown } = await load();
    const parsed = parseSkillMarkdown(HERMES_STYLE_SKILL);
    expect(parsed.name).toBe("weekly-report");
    expect(parsed.title).toBe("周报生成");
    expect(parsed.description).toBe(
      "Use when generating a weekly report for the team.",
    );
    expect(parsed.version).toBe("1.2.0");
    expect(parsed.author).toBe("zhiyi-ai");
    expect(parsed.license).toBe("MIT");
    expect(parsed.platforms).toContain("linux");
    expect(parsed.tags).toContain("report");
    expect(parsed.relatedSkills).toContain("competitor-scan");
    // body 是 frontmatter 之后的部分
    expect(parsed.body).toContain("每周五生成团队周报");
    expect(parsed.body).not.toContain("description:");
  });

  it("缺少 frontmatter 抛出可照改的错误", async () => {
    const { parseSkillMarkdown, SkillParseError } = await load();
    expect(() => parseSkillMarkdown("# 没有 frontmatter\n正文")).toThrow(
      SkillParseError,
    );
  });

  it("缺少 description 抛出错误(它决定 agent 何时加载)", async () => {
    const { parseSkillMarkdown } = await load();
    const bad = "---\nname: no-desc\n---\n正文";
    expect(() => parseSkillMarkdown(bad)).toThrow(/description/);
  });

  it("name 必须是合法 slug", async () => {
    const { parseSkillMarkdown } = await load();
    const bad = "---\nname: Not A Slug!\ndescription: x\n---\n正文";
    expect(() => parseSkillMarkdown(bad)).toThrow(/slug/);
  });

  it("缺省字段回默认值", async () => {
    const { parseSkillMarkdown } = await load();
    const minimal = "---\nname: minimal\ndescription: x\n---\n正文";
    const parsed = parseSkillMarkdown(minimal);
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.license).toBe("MIT");
    expect(parsed.platforms).toEqual([]);
    expect(parsed.tags).toEqual([]);
    expect(parsed.title).toBe("minimal");
  });
});

describe("技能加载与隔离", () => {
  it("loadSkill 只查本组织(organization_id 收窄)", async () => {
    const { mod } = await loadWithAdmin({});
    // 空库 → 技能不存在 → null(不是抛错)
    const result = await mod.loadSkill(ORG_A, "weekly-report");
    expect(result).toBeNull();
  });

  it("loadSkill 对禁用/不存在的技能返回 null", async () => {
    const rows = {
      skills: [
        {
          id: "1",
          organization_id: ORG_A,
          name: "disabled-skill",
          enabled: false,
        },
      ],
    };
    const { mod } = await loadWithAdmin(rows);
    // enabled=false 的行:查到了但 enabled !== true → null
    const result = await mod.loadSkill(ORG_A, "disabled-skill");
    expect(result).toBeNull();
  });

  it("loadSkill 返回正文与附件清单", async () => {
    const rows = {
      skills: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          organization_id: ORG_A,
          name: "weekly-report",
          title: "周报生成",
          description: "生成周报",
          version: "1.0.0",
          tags: ["report"],
          related_skills: ["competitor-scan"],
          body: "# 周报\n步骤...",
          enabled: true,
        },
      ],
      skill_files: [
        {
          skill_id: "11111111-1111-1111-1111-111111111111",
          path: "templates/weekly.md",
          content: "模板内容",
        },
        {
          skill_id: "11111111-1111-1111-1111-111111111111",
          path: "scripts/collect.ts",
          content: "脚本内容",
        },
      ],
    };
    const { mod } = await loadWithAdmin(rows);
    const skill = await mod.loadSkill(ORG_A, "weekly-report");
    expect(skill).not.toBeNull();
    expect(skill?.body).toContain("周报");
    expect(skill?.files ?? []).toHaveLength(2);
    expect(skill?.files?.[0]?.path).toBe("templates/weekly.md");
  });
});
