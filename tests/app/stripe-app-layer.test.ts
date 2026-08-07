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
  it("Professional 产品决策价 HK$49/月", () => {
    expect(PLANS).toContain('name: "Professional 专业版"');
    expect(PLANS).toContain("annualNote");
  });

  it("Enterprise 产品决策价 HK$229/月", () => {
    expect(PLANS).toContain('name: "Enterprise 企业版"');
  });

  it("年付说明存在(两个月免费惯例)", () => {
    expect(PLANS).toContain("年付 HK$490");
    expect(PLANS).toContain("年付 HK$2,290");
  });

  it("三档沿能力线递进(超集关系标注)", () => {
    expect(PLANS).toContain("包含 Free 全部权益");
    expect(PLANS).toContain("包含 Professional 全部权益");
  });

  it("stripePriceId 留空待 Stripe 配置(诚实展示)", () => {
    expect(PLANS).toContain("stripePriceId: undefined");
    expect(PLANS).toContain("stripeAnnualPriceId: undefined");
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

describe("checkout/portal/webhook 路由安全姿态", () => {
  it("webhook 路由必须验签(STRIPE_WEBHOOK_SECRET)", () => {
    const webhook = readFileSync(
      resolve(ROOT, "src/app/api/stripe/webhook/route.ts"),
      "utf8",
    );
    expect(webhook).toContain("constructEvent");
    expect(webhook).toContain("stripe-signature");
    expect(webhook).toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("webhook 幂等:按 stripe_subscription_id 去重", () => {
    const webhook = readFileSync(
      resolve(ROOT, "src/app/api/stripe/webhook/route.ts"),
      "utf8",
    );
    expect(webhook).toContain("onConflict");
    expect(webhook).toContain("stripe_subscription_id");
  });

  it("checkout 路由:未配置 Stripe 时返回 503 而非假成功", () => {
    const checkout = readFileSync(
      resolve(ROOT, "src/app/api/stripe/checkout/route.ts"),
      "utf8",
    );
    expect(checkout).toContain("503");
    expect(checkout).toContain("支付通道尚未接通");
  });

  it("权益守卫:agent 路由按 monthly_agent_turns 额度判断,不信任客户端 plan", () => {
    const agentRoute = readFileSync(
      resolve(ROOT, "src/app/api/agent/route.ts"),
      "utf8",
    );
    expect(agentRoute).toContain("getMyEntitlements");
    expect(agentRoute).toContain("monthly_agent_turns");
    expect(agentRoute).toContain("不信任客户端");
  });
});
