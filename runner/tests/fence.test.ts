import { describe, expect, it } from "vitest";
import { insertStepFenced, updateCheckpointFenced, finishFenced } from "../src/fence.js";

/** 构造 fence 上下文 mock */
function makeCtx(runId = "run-1", gen = 3) {
  const queries: { sql: string; params: unknown[] }[] = [];
  return {
    ctx: { pg: { query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [{ id: runId }] }; // 默认命中
    } } as never, runId, leaseGeneration: gen },
    queries,
  };
}

describe("fence 写保护(阶段 E)", () => {
  it("insertStepFenced 用 INSERT...SELECT 原子校验 generation", async () => {
    const { ctx, queries } = makeCtx();
    const ok = await insertStepFenced(ctx, {
      stepIndex: 1,
      toolCallId: "call-1",
      toolName: "zhiyi_whoami",
      arguments: {},
      resultPreview: "ok",
      resultChars: 2,
      previewChars: 2,
      truncated: false,
      durationMs: 100,
      ok: true,
    });
    expect(ok).toBe(true);
    const sql = queries[0]!.sql;
    expect(sql).toContain("INSERT INTO public.agent_steps");
    expect(sql).toContain("FROM public.agent_runs");
    expect(sql).toContain("lease_generation = $");
    expect(sql).toContain("lease_expires_at > now()");
    // 最后一个参数是 generation
    const params = queries[0]!.params;
    expect(params[params.length - 1]).toBe(3);
  });

  it("updateCheckpointFenced 拒绝 terminal 状态", async () => {
    const { ctx, queries } = makeCtx();
    const ok = await updateCheckpointFenced(ctx, 5);
    expect(ok).toBe(true);
    expect(queries[0]!.sql).toContain("status NOT IN ('completed', 'failed', 'interrupted', 'cancelled')");
  });

  it("finishFenced 带 worker + generation + active 状态 CAS", async () => {
    const { ctx, queries } = makeCtx();
    const ok = await finishFenced(ctx, "worker-a", "completed");
    expect(ok).toBe(true);
    const sql = queries[0]!.sql;
    expect(sql).toContain("claimed_by = $");
    expect(sql).toContain("lease_generation = $");
    expect(sql).toContain("status IN ('running', 'waiting_model', 'running_tool')");
    expect(sql).toContain("resumable = ($2 = 'interrupted')");
  });

  it("fence 0 行 = 拒绝(fence lost)", async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const ctx = {
      pg: { query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        return { rows: [] }; // 0 行 = 被接管
      } } as never,
      runId: "run-1",
      leaseGeneration: 3,
    };
    const ok = await finishFenced(ctx, "worker-a", "completed");
    expect(ok).toBe(false);
  });
});
