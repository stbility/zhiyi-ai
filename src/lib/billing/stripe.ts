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
 * interval:month 读 STRIPE_PRICE_<KEY>_MONTH,year 读 STRIPE_PRICE_<KEY>_YEAR。
 * 未配置返回 null,由调用方如实降级(503 + 提示),绝不伪造成功路径。
 *
 * 新 5 档命名(对齐 plans.ts):
 *   pro/pro_plus/team → STRIPE_PRICE_PRO_MONTH / STRIPE_PRICE_PRO_PLUS_MONTH / STRIPE_PRICE_TEAM_MONTH
 *   enterprise 无固定 Price ID(Payment Link 为主)
 */
export function getPriceIdForPlan(
  planId: string,
  interval: "month" | "year" = "month",
): string | null {
  const suffix = interval === "year" ? "_YEAR" : "_MONTH";
  const envKey: string | undefined = {
    professional: "STRIPE_PRICE_PRO_MONTH",
    professional_plus: "STRIPE_PRICE_PRO_PLUS_MONTH",
    team: "STRIPE_PRICE_TEAM_MONTH",
  }[planId];
  if (envKey) {
    return process.env[envKey.replace("_MONTH", suffix)]?.trim() ?? null;
  }
  return null;
}

/**
 * Price ID → plan_id 反向映射(webhook 用)。
 *
 * 新 5 档:professional/professional_plus/team → 各自 month/year 共 6 个 Price ID;
 * enterprise 无固定 Price(Payment Link 为主,不会走此路径)。
 */
export function getPlanIdForPrice(priceId: string): string | null {
  const candidates: ReadonlyArray<readonly [string | undefined, string]> = [
    [process.env["STRIPE_PRICE_PRO_MONTH"], "professional"],
    [process.env["STRIPE_PRICE_PRO_YEAR"], "professional"],
    [process.env["STRIPE_PRICE_PRO_PLUS_MONTH"], "professional_plus"],
    [process.env["STRIPE_PRICE_PRO_PLUS_YEAR"], "professional_plus"],
    [process.env["STRIPE_PRICE_TEAM_MONTH"], "team"],
    [process.env["STRIPE_PRICE_TEAM_YEAR"], "team"],
  ];
  for (const [id, plan] of candidates) {
    if (id && id === priceId) return plan;
  }
  return null;
}

/**
 * plan + interval → Price ID(官方做法 = 环境变量显式配置)。
 *
 * 2026-08-10 清理:移除「目录自解析」(price-catalog)——不配 id 也能跑
 * 会把 STRIPE_PRICE_* 缺失伪装成可用,是错误做法;官方做法是显式配置,
 * 未配则返回 null,调用方如实 503(降级 Payment Link)。
 */
export async function resolvePriceIdForPlan(
  _stripe: Stripe,
  planId: string,
  interval: "month" | "year",
): Promise<string | null> {
  return getPriceIdForPlan(planId, interval);
}

/**
 * Price ID → plan(webhook 用):
 *   1. metadata.plan_id 白名单(调用方已优先处理)
 *   2. 环境变量映射(STRIPE_PRICE_*)
 * 未配返回 null,webhook 拒绝落库(500 重试),绝不静默降级 free。
 */
export async function resolvePlanIdForPrice(
  _stripe: Stripe,
  priceId: string,
): Promise<string | null> {
  return getPlanIdForPrice(priceId);
}
