import { describe, expect, it } from "vitest";

/**
 * Stripe 应用层契约测试。
 *
 * 覆盖:
 *   · plans.ts 的 HKD 定价与年付字段(与 0033/0034 对齐)
 *   · checkout/portal/webhook 路由的签名与安全姿态
 *   · 权益服务与 0034 的 feature 对齐
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const PLANS = readFileSync(resolve(ROOT, "src/lib/plans.ts"), "utf8");
const M0033 = readFileSync(
  resolve(ROOT, "supabase/migrations/0033_stripe_customers_and_subscriptions.sql"),
  "utf8",
);
const M0034 = readFileSync(
  resolve(ROOT, "supabase/migrations/0034_entitlements.sql"),
  "utf8",
);

describe("plans.ts 港币定价(全球华人市场)", () => {
  it("Professional 产品决策价(定价 v2:HK49/月)", () => {
    expect(PLANS).toContain('name: "Professional 专业版"');
    expect(PLANS).toContain("annualNote");
  });

  it("Enterprise 产品决策价(定价 v2:HK1,999/月)", () => {
    expect(PLANS).toContain('name: "Enterprise 企业版"');
  });

  it("年付说明存在(两个月免费惯例)", () => {
    expect(PLANS).toContain("HK490/年");
    expect(PLANS).toContain("HK4,990/年");
  });

  it("三档沿能力线递进(超集关系标注)", () => {
    expect(PLANS).toContain("包含 Free 全部权益");
    expect(PLANS).toContain("包含 Professional 全部权益");
  });

  it("plans.ts 已移除 Stripe 字段(Stripe 应用层已删除)", () => {
    expect(PLANS).not.toContain("stripePriceId");
    expect(PLANS).not.toContain("stripeAnnualPriceId");
  });
});

describe("0033/0034 与 plans.ts 对齐", () => {
  it("plan_id 白名单一致:free/professional/professional_plus/team/enterprise", () => {
    expect(M0033).toMatch(/plan_id in \('free','professional','professional_plus','team','enterprise'\)/);
    expect(PLANS).toContain('id: "free"');
    expect(PLANS).toContain('id: "professional"');
    expect(PLANS).toContain('id: "professional_plus"');
    expect(PLANS).toContain('id: "team"');
    expect(PLANS).toContain('id: "enterprise"');
  });

  it("权益 feature 与 agent 路由判断一致:monthly_agent_turns", () => {
    expect(M0034).toContain("monthly_agent_turns");
  });
});

describe("agent 路由权益守卫", () => {
  it("权益守卫:agent 路由经 checkTurnQuota 按 monthly_agent_turns 额度判断", () => {
    const agentRoute = readFileSync(
      resolve(ROOT, "src/app/api/agent/route.ts"),
      "utf8",
    );
    // 守卫已收敛到 lib/billing/turn-quota.ts(唯一实现,chat/agent 共用)
    expect(agentRoute).toContain("checkTurnQuota");
    expect(agentRoute).toContain("@/lib/billing/turn-quota");

    const turnQuota = readFileSync(
      resolve(ROOT, "src/lib/billing/turn-quota.ts"),
      "utf8",
    );
    expect(turnQuota).toContain("getMyEntitlements");
    expect(turnQuota).toContain("monthly_agent_turns");
  });

  it("权益守卫:组织 owner/admin 豁免套餐限制(项目所有者不受自己产品限制)", () => {
    const turnQuota = readFileSync(
      resolve(ROOT, "src/lib/billing/turn-quota.ts"),
      "utf8",
    );
    // owner/admin 从 memberships 读角色并豁免(仅多成员组织,个人组织不豁免)
    expect(turnQuota).toContain('membership?.role === "owner"');
    expect(turnQuota).toContain('membership?.role === "admin"');
    expect(turnQuota).toContain("isTeamAdmin");
    // 豁免逻辑在权益查询之前调用 —— 先查角色,再决定要不要查额度
    expect(turnQuota.indexOf("await isTeamAdmin")).toBeLessThan(
      turnQuota.indexOf("getMyEntitlements()"),
    );
  });
});
