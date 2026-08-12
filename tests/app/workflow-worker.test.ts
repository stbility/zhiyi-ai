import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 后台 Worker 与人工闸门契约(2026-08-12,阶段 4 收口)。
 *
 * 背景:0036 状态机 10 态先于执行器就位,WAITING_FOR_INPUT 一直未被
 * 执行器使用;runWorkflow 同步执行阻塞前端。本轮:
 *   1. runWorkflow 改为入队(QUEUED),前端调 /api/workflow/worker 执行
 *   2. executeSteps 抽为 executeWorkflowSteps(server action + worker 共用)
 *   3. 步骤支持 needsInput(等待输入闸门)+ submitWorkflowInput 续跑
 *   4. worker route 带 CRON_SECRET 兜底清理僵尸 QUEUED
 */

const ACTIONS = readFileSync(
  resolve(__dirname, "../../src/app/(app)/workflow/actions.ts"),
  "utf8",
);
const EXECUTE = readFileSync(
  resolve(__dirname, "../../src/lib/workflow/execute.ts"),
  "utf8",
);
const STATE = readFileSync(
  resolve(__dirname, "../../src/lib/workflow/state-machine.ts"),
  "utf8",
);
const WORKER = readFileSync(
  resolve(__dirname, "../../src/app/api/workflow/worker/route.ts"),
  "utf8",
);
const MANAGER = readFileSync(
  resolve(__dirname, "../../src/components/app/WorkflowManager.tsx"),
  "utf8",
);

describe("后台 Worker 与人工闸门", () => {
  it("runWorkflow 入队化:不再同步执行,返回排队结果", () => {
    expect(ACTIONS).toMatch(/已排队/);
    expect(ACTIONS).toMatch(/queuedRunId/);
    // 不再有同步执行的置 RUNNING 序列
    expect(ACTIONS).not.toMatch(/status: "RUNNING", started_at/);
  });

  it("执行器抽到共享模块 executeWorkflowSteps(worker 复用)", () => {
    expect(EXECUTE).toMatch(/export async function executeWorkflowSteps/);
    expect(ACTIONS).toMatch(/executeWorkflowSteps/);
    expect(WORKER).toMatch(/executeWorkflowSteps/);
  });

  it("步骤支持 needsInput 等待输入闸门", () => {
    expect(STATE).toMatch(/needsInput\?: boolean/);
    expect(STATE).toMatch(/inputLabel\?: string/);
    expect(EXECUTE).toMatch(/WAITING_FOR_INPUT/);
    // 提交输入续跑
    expect(ACTIONS).toMatch(/export async function submitWorkflowInput/);
    expect(ACTIONS).toMatch(/pending_input/);
  });

  it("worker route:用户触发执行 + Cron 兜底清僵尸", () => {
    expect(WORKER).toMatch(/CRON_SECRET/);
    expect(WORKER).toMatch(/ZOMBIE_AFTER_MS/);
    expect(WORKER).toMatch(/organization_id !== organization.id/);
  });

  it("前端:运行走轮询 worker,等待输入有提交 UI", () => {
    expect(MANAGER).toMatch(/async function runQueued/);
    expect(MANAGER).toMatch(/\/api\/workflow\/worker\?runId=/);
    expect(MANAGER).toMatch(/WAITING_FOR_INPUT/);
    expect(MANAGER).toMatch(/submitWorkflowInput/);
    expect(MANAGER).toMatch(/需要人工输入/);
  });

  it("vercel.json 配置了 cron 兜底", () => {
    const vercel = readFileSync(resolve(__dirname, "../../vercel.json"), "utf8");
    expect(vercel).toMatch(/api\/workflow\/worker/);
    expect(vercel).toMatch(/cron/);
  });
});
