import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const M0039 = readFileSync(
  resolve(__dirname, "../../supabase/migrations/0039_eval_runs.sql"),
  "utf8",
);

describe("0039 评测运行迁移", () => {
  it("eval_runs 与 eval_run_cases 表存在,状态机正确", () => {
    expect(M0039).toContain("create table if not exists public.eval_runs");
    expect(M0039).toContain("create table if not exists public.eval_run_cases");
    expect(M0039).toMatch(/status\s+text not null default 'running' check \(status in \('running','completed','partial'\)\)/);
    expect(M0039).toMatch(/check \(status in \('passed','failed','skipped','timeout'\)\)/);
  });

  it("RLS:自己的运行自己看,级联删用例结果", () => {
    expect(M0039).toMatch(/on delete cascade/);
    expect(M0039).toContain("eval_runs_select_own");
    expect(M0039).toContain("eval_runs_insert_own");
    expect(M0039).toContain("eval_run_cases_select_own");
  });

  it("版本与通过率字段齐备(可复现对比的数据基础)", () => {
    expect(M0039).toMatch(/version_sha\s+text not null/);
    expect(M0039).toMatch(/pass_rate\s+numeric not null default 0/);
    expect(M0039).toContain("eval_runs_created_by_idx");
  });
});
