import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 权益一致契约(2026-08-12,阶段 6 收口)。
 *
 * 背景:0055 扩展的 6 个 feature 里,concurrent_tasks / history_days
 * 有种子无 gating —— 营销页承诺了并发数与历史保留天数,代码不拦。
 * 本轮补齐:
 *   1. concurrent_tasks:agent 入口 + workflow 入队检查(checkConcurrentTasks)
 *   2. history_days:会话列表按档位过滤可见历史(loadConversations)
 */

const AGENT = readFileSync(resolve(__dirname, "../../src/app/api/agent/route.ts"), "utf8");
const CONCURRENCY = readFileSync(
  resolve(__dirname, "../../src/lib/billing/concurrency.ts"),
  "utf8",
);
const CONVERSATIONS = readFileSync(
  resolve(__dirname, "../../src/lib/db/conversations.ts"),
  "utf8",
);
const ACTIONS = readFileSync(
  resolve(__dirname, "../../src/app/(app)/workflow/actions.ts"),
  "utf8",
);
const EXECUTE = readFileSync(
  resolve(__dirname, "../../src/lib/workflow/execute.ts"),
  "utf8",
);

describe("权益一致(concurrent_tasks / history_days)", () => {
  it("concurrent_tasks:agent 入口检查 + worker 步骤跳过(防自锁)", () => {
    expect(AGENT).toMatch(/checkConcurrentTasks/);
    expect(AGENT).toMatch(/x-zhiyi-worker/);
    // 续跑(resumeRunId)也跳过 —— 已付费的运行不掐断
    expect(AGENT).toMatch(/!resumeRunId && request\.headers\.get\("x-zhiyi-worker"\)/);
  });

  it("concurrent_tasks:共享检查实现(fail-closed + 双通道计数)", () => {
    expect(CONCURRENCY).toMatch(/export async function checkConcurrentTasks/);
    expect(CONCURRENCY).toMatch(/agent_runs/);
    expect(CONCURRENCY).toMatch(/workflow_runs/);
    // 异常 fail-closed:get_entitlements 失败按 0(拦截)
    expect(CONCURRENCY).toMatch(/quota <= 0/);
    // 不限档位(Team/Enterprise null)放行
    expect(CONCURRENCY).toMatch(/quota === null/);
  });

  it("concurrent_tasks:workflow 入队检查(worker 步骤带标记)", () => {
    expect(ACTIONS).toMatch(/checkConcurrentTasks/);
    expect(EXECUTE).toMatch(/x-zhiyi-worker/);
  });

  it("history_days:会话列表按档位过滤", () => {
    expect(CONVERSATIONS).toMatch(/quotaOf\(entitlements, "history_days"\)/);
    expect(CONVERSATIONS).toMatch(/gte\("created_at", cutoff\)/);
    // fail-closed:entitlements 失败按 0 天(看不到历史)
    expect(CONVERSATIONS).toMatch(/entitlements \? quotaOf\(entitlements, "history_days"\) : 0/);
  });
});
