/**
 * 契约:POST /api/agent/runs(异步入队)的 insert 归一化。
 *
 * 背景(2026-08-25 生产事故):route.ts 曾把 providerId 原样写入
 * agent_runs.provider_id —— 平台免费档的 providerId 是
 * "platform:openai_compatible:…" 伪标识(非 UUID),而
 * agent_runs.provider_id 是 uuid references ai_providers(id)(0027),
 * FK 拒绝 → 500「创建运行失败」,平台免费档长任务 100% 失败。
 *
 * 同步路径(agent-turn.ts)早已有同语义处理:
 *   provider_id: isPlatformProviderId(...) ? null : selected.providerId
 * 本测试守住异步路径与同步路径一致,防同型回归。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RUNS_ROUTE = readFileSync(
  resolve(__dirname, "../../src/app/api/agent/runs/route.ts"),
  "utf8",
);

describe("POST /api/agent/runs 入队契约", () => {
  it("平台免费档 provider_id 归一化为 null(防 FK 撞墙)", () => {
    expect(RUNS_ROUTE).toMatch(
      /provider_id:\s*isPlatformProviderId\(providerId\)\s*\?\s*null\s*:\s*providerId/,
    );
    expect(RUNS_ROUTE).toMatch(/import\s*\{[^}]*isPlatformProviderId/);
  });

  it("入队 status 固定为 queued,不执行 agent", () => {
    expect(RUNS_ROUTE).toMatch(/status:\s*"queued"/);
    expect(RUNS_ROUTE).not.toMatch(/runAgentTurn/);
  });

  it("flag 关闭时端点 404(AGENT_ASYNC_ENABLED !== \"1\")", () => {
    expect(RUNS_ROUTE).toMatch(/AGENT_ASYNC_ENABLED\s*!==\s*"1"/);
    expect(RUNS_ROUTE).toMatch(/404/);
  });
});
