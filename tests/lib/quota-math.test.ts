import { describe, expect, it } from "vitest";

import {
  agentTurnBlockReason,
  quotaRemaining,
  sumUsageRows,
} from "@/lib/billing/quota-math";

describe("额度数学(P0-3)", () => {
  it("quota null = 不限额度,永不拦截", () => {
    expect(quotaRemaining(null, 999)).toBeNull();
    expect(agentTurnBlockReason({ quota: null, used: 999 })).toBeNull();
  });

  it("剩余 = 配额 - 已用量", () => {
    expect(quotaRemaining(500, 120)).toBe(380);
    expect(quotaRemaining(500, 500)).toBe(0);
    expect(quotaRemaining(500, 600)).toBe(0); // 超用不出现负数
  });

  it("已用量达到配额即拦截,且报错含已用/配额", () => {
    expect(agentTurnBlockReason({ quota: 200, used: 199 })).toBeNull();
    const reason = agentTurnBlockReason({ quota: 200, used: 200 });
    expect(reason).not.toBeNull();
    expect(reason).toContain("200/200");
    expect(agentTurnBlockReason({ quota: 200, used: 250 })).not.toBeNull();
  });

  it("汇总多行用量(按月累计)", () => {
    expect(
      sumUsageRows([
        { units: 3 },
        { units: 7 },
        { units: null },
        { units: 0 },
      ]),
    ).toBe(10);
    expect(sumUsageRows([])).toBe(0);
  });
});
