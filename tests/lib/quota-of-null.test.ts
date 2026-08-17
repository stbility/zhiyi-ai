import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  quotaOf,
  type Entitlements,
} from "@/lib/billing/entitlements";
import {
  agentTurnBlockReason,
  quotaRemaining,
} from "@/lib/billing/quota-math";

function makeEntitlements(
  rows: [string, number | null][],
): Entitlements {
  return { planId: "enterprise", byFeature: new Map(rows) };
}

describe("quotaOf(null 不限不能被兜底成 0)【2026-08-17 回归】", () => {
  it("feature 存在且 quota=null(enterprise 不限)→ 返回 null,不是 0", () => {
    const e = makeEntitlements([["monthly_agent_turns", null]]);
    // 修复前:quota ?? 0 把 null 转成 0 → quotaRemaining(0, used) 恒拦截
    // 修复后:null 原样返回 → agentTurnBlockReason 放行
    expect(quotaOf(e, "monthly_agent_turns")).toBeNull();
  });

  it("feature 存在且 quota=数字 → 返回该数字", () => {
    const e = makeEntitlements([["monthly_agent_turns", 2000]]);
    expect(quotaOf(e, "monthly_agent_turns")).toBe(2000);
  });

  it("feature 未配置(Map 无此 key)→ 返回 0(与修复前一致)", () => {
    const e = makeEntitlements([]);
    expect(quotaOf(e, "monthly_agent_turns")).toBe(0);
  });

  it("整条链路:enterprise null → checkTurnQuota 判定逻辑放行", () => {
    const e = makeEntitlements([
      ["monthly_agent_turns", null],
      ["concurrent_tasks", null],
    ]);
    // quotaOf 正确返回 null 后,quotaRemaining(null, used) = null → 不拦截
    const quota = quotaOf(e, "monthly_agent_turns");
    expect(quotaRemaining(quota, 42)).toBeNull();
    expect(agentTurnBlockReason({ quota, used: 42 })).toBeNull();
  });
});
