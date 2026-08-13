import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * P0-4 计量口径契约(2026-08-13 修正)。
 *
 * 背景:计量发生在 finish(),units=max(1, stepCount) 一次扣完 ——
 * 失败/中断也扣,0 步也扣 1;plans.ts 声称「平台故障自动返还」却无实现。
 *
 * 修正:计量时机从 finish 一次性扣改为 record() 每完成一步扣 1:
 *   - 中断/失败只计已完成步骤
 *   - 平台故障且一步未完成 → 计 0(自动返还语义,无需显式减量)
 * 文案同步如实化。
 */
const JOURNAL = readFileSync(
  resolve(__dirname, "../../src/lib/ai/run-journal.ts"),
  "utf8",
);
const PLANS = readFileSync(resolve(__dirname, "../../src/lib/plans.ts"), "utf8");
const BILLING = readFileSync(
  resolve(__dirname, "../../src/components/app/BillingManager.tsx"),
  "utf8",
);

describe("P0-4 按完成步骤计量", () => {
  it("record() 每完成一步 bump_usage(1)", () => {
    expect(JOURNAL).toMatch(/p_category: "agent_turns"/);
    expect(JOURNAL).toMatch(/p_units: 1/);
    // 计量块在 record() 内(与 agent_steps insert 同函数)
    const recordBlock = JOURNAL.slice(
      JOURNAL.indexOf("async record(step: AgentStep)"),
      JOURNAL.indexOf("async finish("),
    );
    expect(recordBlock).toMatch(/bump_usage/);
  });

  it("finish() 不再做一次性计量(只收尾状态)", () => {
    const finishBlock = JOURNAL.slice(JOURNAL.indexOf("async finish("));
    expect(finishBlock).not.toMatch(/bump_usage/);
    expect(finishBlock).not.toMatch(/Math\.max\(1, stepCount\)/);
  });

  it("openRunJournal 缓存 conversation.user_id 供 record 计费", () => {
    expect(JOURNAL).toMatch(/convUserId/);
    expect(JOURNAL).toMatch(/from\("conversations"\)/);
  });

  it("plans.ts 计次定义如实描述按步口径", () => {
    expect(PLANS).toMatch(/计量粒度为\*\*实际完成的步骤数\*\*/);
    expect(PLANS).toMatch(/一步未完成[\s\S]*计 0/);
  });

  it("billing 页用量条文案同步(步骤单位 + 口径说明)", () => {
    expect(BILLING).toMatch(/智能体步骤 \(agent_turns\)/);
    expect(BILLING).toMatch(/按实际完成的智能体步骤计次/);
  });
});
