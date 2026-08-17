import { describe, expect, it, vi } from "vitest";
import { claimRun } from "../src/claim.js";

/** 最小 pg 客户端 mock:记录查询并返回可控结果 */
function makeMockClient(rows: unknown[][] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const client = {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      // SELECT 返回 rows[0],UPDATE 返回 rows[1]...
      const idx = calls.length - 1;
      const result = rows[idx] ?? [];
      return { rows: result };
    },
  };
  return client;
}

describe("claimRun", () => {
  it("无可用任务时返回 null(且不执行 UPDATE)", async () => {
    const client = makeMockClient([[]]); // SELECT 0 行
    const result = await claimRun(client as never, {
      workerId: "worker-1",
    });
    expect(result).toBeNull();
    // 只发了 SELECT,没发 UPDATE
    expect(client.calls.length).toBe(1);
    expect(client.calls[0]!.sql).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("领取成功:SELECT 命中 + UPDATE lease + generation+1", async () => {
    const client = makeMockClient([
      [
        {
          id: "run-1",
          conversation_id: "conv-1",
          organization_id: "org-1",
          status: "queued",
          current_step: 0,
          resumable: false,
        },
      ],
      [{ lease_generation: 7 }],
    ]);
    const result = await claimRun(client as never, {
      workerId: "worker-1",
    });
    expect(result).not.toBeNull();
    expect(result!.runId).toBe("run-1");
    expect(result!.leaseGeneration).toBe(7);
    // UPDATE 带 lease_generation = lease_generation + 1
    const update = client.calls[1]!;
    expect(update.sql).toContain("lease_generation = lease_generation + 1");
    expect(update.sql).toContain("status = 'running'");
  });

  it("领取 SQL 含 SKIP LOCKED 原子语义(D3 冻结)", async () => {
    const client = makeMockClient([[]]);
    await claimRun(client as never, { workerId: "w" });
    const sql = client.calls[0]!.sql;
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("claimed_by IS NULL OR lease_expires_at < now()");
  });
});
