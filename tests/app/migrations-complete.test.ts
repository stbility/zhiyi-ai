import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 仓库必须能独立重建数据库。
 *
 * 真实问题:Supabase 云端有 18 个迁移,仓库里只有 13 个文件,其中
 * 0011 和 0017 打开一看只有注释,正文写着「完整语句见 Supabase 迁移记录」。
 * workspaces / workspace_files / ai_model_exclusions / rate_limits
 * 四张表的建表语句只存在于云端。
 *
 * 后果:新环境起不来、本地跑不了、Supabase 项目一旦误删无法恢复,
 * 而且这几张表的 RLS 策略没人能审 —— 无法回答「工作区文件真的做了
 * 组织隔离吗」。这是当时唯一的单点失效。
 *
 * 这条测试守住:代码里 .from("x") 用到的每张表,仓库里都要有建表语句。
 */

const MIGRATIONS = resolve(__dirname, "../../supabase/migrations");
const SRC = resolve(__dirname, "../../src");

function allFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(full, ext));
    else if (e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

const sql = allFiles(MIGRATIONS, ".sql")
  .map((f) => readFileSync(f, "utf8"))
  .join("\n")
  .toLowerCase();

/** 代码里所有 .from("表名") 引用到的表 */
function tablesUsedInCode(): Set<string> {
  const used = new Set<string>();
  for (const file of [...allFiles(SRC, ".ts"), ...allFiles(SRC, ".tsx")]) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g)) {
      if (m[1]) used.add(m[1]);
    }
  }
  return used;
}

describe("迁移完整性", () => {
  it("代码用到的每张表,仓库里都有建表语句", () => {
    const missing = [...tablesUsedInCode()].filter(
      (t) => !new RegExp(`create table (if not exists )?public\\.${t}\\b`).test(sql),
    );
    expect(missing, `以下表只存在于云端,仓库无法重建:${missing.join("、")}`).toEqual([]);
  });

  it("没有只有注释的空壳迁移", () => {
    const shells = allFiles(MIGRATIONS, ".sql").filter((f) => {
      const body = readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));
      return body.length === 0;
    });
    expect(shells.map((f) => f.split("/").pop())).toEqual([]);
  });

  it("限流函数的授权收紧语句在仓库里", () => {
    // 它必须建在 public(PostgREST 不路由 private schema,service_role 调不到),
    // 但放在 public 就要显式收回 anon / authenticated 的执行权
    expect(sql).toContain("bump_rate_limit");
    expect(sql).toMatch(/revoke all on function public\.bump_rate_limit/);
    expect(sql).toMatch(/grant execute on function public\.bump_rate_limit\(text, integer\) to service_role/);
  });

  it("工作区文件按组织隔离 —— 这是审查时无法验证的那一条", () => {
    expect(sql).toMatch(/create policy workspace_files_select_member[\s\S]*?is_org_member\(organization_id\)/);
  });
});
