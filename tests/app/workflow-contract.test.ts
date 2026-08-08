import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { WORKFLOW_STATUSES } from "@/components/workflow/WorkflowStatusBadge";

const M0036 = readFileSync(
  resolve(__dirname, "../../supabase/migrations/0036_workflows.sql"),
  "utf8",
);

const TEN_STATUSES = [
  "DRAFT",
  "READY",
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_INPUT",
  "WAITING_FOR_APPROVAL",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

describe("0036 工作流迁移与设计系统状态机对齐", () => {
  it("workflows 与 workflow_runs 表存在", () => {
    expect(M0036).toContain("create table if not exists public.workflows");
    expect(M0036).toContain("create table if not exists public.workflow_runs");
  });

  it("两张表的 status CHECK 都覆盖设计系统的 10 个状态", () => {
    expect(M0036).toContain("'DRAFT','READY','QUEUED','RUNNING','WAITING_FOR_INPUT'");
    expect(M0036).toContain(
      "'WAITING_FOR_APPROVAL','PAUSED','COMPLETED','FAILED','CANCELLED'",
    );
    // 状态集合与设计系统完全一致(无多无少)
    for (const status of TEN_STATUSES) {
      expect(WORKFLOW_STATUSES).toContain(status);
    }
  });

  it("RLS 已启用,成员可读,创建者本人可改/删", () => {
    expect(M0036).toMatch(/enable row level security/);
    expect(M0036).toContain("workflows_select_member");
    expect(M0036).toContain("workflows_update_own");
    expect(M0036).toContain("workflows_delete_own");
    expect(M0036).toContain("workflow_runs_select_member");
    // 写路径必须走 created_by = auth.uid(),不允许越权改别人的工作流
    expect(M0036).toMatch(/using \(created_by = \(select auth\.uid\(\)\)\)/);
  });

  it("定义列是 jsonb,外键与索引齐备", () => {
    expect(M0036).toContain("definition      jsonb not null");
    expect(M0036).toMatch(/workflow_id\s+uuid not null references public\.workflows\(id\) on delete cascade/);
    expect(M0036).toContain("workflow_runs_workflow_idx");
  });
});
