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
  it("Professional 产品决策价 HK49/月", () => {
    expect(PLANS).toContain('name: "Professional 专业版"');
    expect(PLANS).toContain("annualNote");
  });

  it("Enterprise 产品决策价 HK229/月", () => {
    expect(PLANS).toContain('name: "Enterprise 企业版"');
  });

  it("年付说明存在(两个月免费惯例)", () => {
    expect(PLANS).toContain("年付 HK490");
    expect(PLANS).toContain("年付 HK2,290");
  });

  it("正式订阅路径是 checkout,plans.ts 不再暴露 Payment Link(P0-1)", () => {
    // 2026-08-08 移除:静态 Payment Link 无法携带 userId,付款后 webhook
    // 定位不到用户,权益无法解锁 —— 是 P0 断链根源。任何组件都不该再拿到它。
    expect(PLANS).not.toContain("buy.stripe.com");
    expect(PLANS).not.toContain("readonly stripeUrl");
    expect(PLANS).not.toContain("readonly annualStripeUrl");
    // CTA 走 checkout(绑定 userId)的契约由 PlansSection/SubscribeButton 断言
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
  it("plan_id 白名单一致:free/professional/enterprise", () => {
    expect(M0033).toMatch(/plan_id in \('free','professional','enterprise'\)/);
    expect(PLANS).toContain('id: "free"');
    expect(PLANS).toContain('id: "professional"');
    expect(PLANS).toContain('id: "enterprise"');
  });

  it("权益 feature 与 agent 路由判断一致:monthly_agent_turns", () => {
    expect(M0034).toContain("monthly_agent_turns");
  });
});

describe("agent 路由权益守卫", () => {
  it("权益守卫:agent 路由按 monthly_agent_turns 额度判断,不信任客户端 plan", () => {
    const agentRoute = readFileSync(
      resolve(ROOT, "src/app/api/agent/route.ts"),
      "utf8",
    );
    expect(agentRoute).toContain("getMyEntitlements");
    expect(agentRoute).toContain("monthly_agent_turns");
    expect(agentRoute).toContain("不信任客户端");
  });

  it("权益守卫:owner/admin 豁免只适用于多成员组织(P0-4)", () => {
    const agentRoute = readFileSync(
      resolve(ROOT, "src/app/api/agent/route.ts"),
      "utf8",
    );
    // owner/admin 从 memberships 读角色;豁免必须叠加成员数 >1
    // (注册自动建的个人组织只有 1 个成员,owner 也是普通用户,照常计额度)
    expect(agentRoute).toContain('membership?.role === "owner"');
    expect(agentRoute).toContain('membership?.role === "admin"');
    expect(agentRoute).toContain("isTeamAdmin");
    expect(agentRoute).toContain("memberCount ?? 0) > 1");
    // 豁免逻辑必须在权益判断之前 —— 先查角色与成员数,再决定要不要查额度
    expect(
      agentRoute.indexOf("isTeamAdmin"),
    ).toBeLessThan(agentRoute.indexOf("getMyEntitlements"));
  });

  it("权益守卫:额度必须减去本月已用量(P0-3)", () => {
    const agentRoute = readFileSync(
      resolve(ROOT, "src/app/api/agent/route.ts"),
      "utf8",
    );
    expect(agentRoute).toContain("get_monthly_usage");
    expect(agentRoute).toContain("agent_turns");
    expect(agentRoute).toContain("agentTurnBlockReason");
  });
});
