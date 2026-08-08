import "server-only";

import Stripe from "stripe";

/**
 * Stripe 服务端装配。
 *
 * 与 GitHub App 装配同一个原则:未配置时返回 null,由调用方如实
 * 显示「未配置」,绝不伪装成已接通。
 *
 * v22 类型钉死的 apiVersion 是 "2026-06-24.dahlia"(2026-08-07 实测,
 * 猜别的日期会直接 typecheck 失败)。
 */

export interface StripeConfig {
  readonly secretKey: string;
  readonly publishableKey: string;
  readonly webhookSecret: string;
}

export function getStripeConfig(): StripeConfig | null {
  const secretKey = process.env["STRIPE_SECRET_KEY"]?.trim();
  if (!secretKey) return null;
  return {
    secretKey,
    publishableKey: process.env["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"]?.trim() ?? "",
    webhookSecret: process.env["STRIPE_WEBHOOK_SECRET"]?.trim() ?? "",
  };
}

export function getStripe(): Stripe | null {
  const config = getStripeConfig();
  if (!config) return null;
  return new Stripe(config.secretKey, {
    apiVersion: "2026-06-24.dahlia",
    typescript: true,
  });
}

/**
 * 套餐对应的 Stripe Price ID,来自环境变量。
 *
 * 价格实体以 Stripe 为准(plans.ts 只放展示文案),Price 上必须带
 * metadata.plan_id ∈ {professional, enterprise} —— webhook 据此判定
 * 套餐,绝不信任客户端传来的 plan 字段。
 */
export function getPriceIdForPlan(planId: string): string | null {
  if (planId === "professional") {
    return process.env["STRIPE_PRICE_PROFESSIONAL"]?.trim() ?? null;
  }
  if (planId === "enterprise") {
    return process.env["STRIPE_PRICE_ENTERPRISE"]?.trim() ?? null;
  }
  return null;
}
