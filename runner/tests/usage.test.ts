import { describe, expect, it, vi } from "vitest";
import { bumpUsageInTx, currentPeriodMonth } from "../src/usage.js";

describe("usage exactly-once", () => {
  it("currentPeriodMonth 返回 YYYY-MM(UTC)", () => {
    const m = currentPeriodMonth();
    expect(m).toMatch(/^\d{4}-\d{2}$/);
  });

  it("bumpUsageInTx 执行 UPSERT ON CONFLICT(幂等累加)", async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const client = {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        return { rows: [{ units: 42 }] };
      },
    };
    const total = await bumpUsageInTx(client as never, {
      userId: "user-1",
      periodMonth: "2026-08",
      category: "agent_turns",
      units: 1,
    });
    expect(total).toBe(42);
    const sql = queries[0]!.sql;
    expect(sql).toContain("ON CONFLICT (user_id, period_month, category)");
    expect(sql).toContain("usage_metering.units + EXCLUDED.units");
    // 不调用 bump_usage RPC(auth.uid 校验会拒绝 service role)
    expect(sql).not.toContain("bump_usage");
  });

  it("bumpUsageInTx 参数含用户/周期/类别/单位", () => {
    const queries: { params: unknown[] }[] = [];
    const client = {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ params });
        return { rows: [{ units: 1 }] };
      },
    };
    void bumpUsageInTx(client as never, {
      userId: "u-9",
      periodMonth: "2026-09",
      category: "agent_turns",
      units: 3,
    });
    expect(queries[0]!.params).toEqual(["u-9", "2026-09", "agent_turns", 3]);
  });
});
