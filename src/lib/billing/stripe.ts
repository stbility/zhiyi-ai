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
 *
 * interval:month(默认)读 STRIPE_PRICE_<PLAN>,year 读 STRIPE_PRICE_<PLAN>_YEAR。
 * 未配置返回 null,由调用方如实降级(503 + 提示),绝不伪造成功路径。
 */
export function getPriceIdForPlan(
  planId: string,
  interval: "month" | "year" = "month",
): string | null {
  if (planId === "professional") {
    return (
      process.env[
        interval === "year"
          ? "STRIPE_PRICE_PROFESSIONAL_YEAR"
          : "STRIPE_PRICE_PROFESSIONAL"
      ]?.trim() ?? null
    );
  }
  if (planId === "professional_plus") {
    return (
      process.env[
        interval === "year"
          ? "STRIPE_PRICE_PROFESSIONAL_PLUS_YEAR"
          : "STRIPE_PRICE_PROFESSIONAL_PLUS"
      ]?.trim() ?? null
    );
  }
  if (planId === "team") {
    return (
      process.env[
        interval === "year"
          ? "STRIPE_PRICE_TEAM_YEAR"
          : "STRIPE_PRICE_TEAM"
      ]?.trim() ?? null
    );
  }
  if (planId === "enterprise") {
    return (
      process.env[
        interval === "year"
          ? "STRIPE_PRICE_ENTERPRISE_YEAR"
          : "STRIPE_PRICE_ENTERPRISE"
      ]?.trim() ?? null
    );
  }
  return null;
}

/**
 * Price ID → plan_id 反向映射(webhook 用)。
 *
 * 生产实测(2026-08-08):4 条 HKD 价格(月/年 × Pro/Ent)的 metadata 全为空,
 * webhook 只认 price.metadata.plan_id 会把所有订阅静默降级成 free ——
 * 用户付了钱权益不变。这里用环境变量里的 Price ID 兜底映射,
 * metadata 缺失时也能判对套餐;两处都配齐时以 metadata 为准。
 */
export function getPlanIdForPrice(priceId: string): string | null {
  const candidates: ReadonlyArray<readonly [string | undefined, string]> = [
    [process.env["STRIPE_PRICE_PROFESSIONAL"], "professional"],
    [process.env["STRIPE_PRICE_PROFESSIONAL_YEAR"], "professional"],
    [process.env["STRIPE_PRICE_PROFESSIONAL_PLUS"], "professional_plus"],
    [process.env["STRIPE_PRICE_PROFESSIONAL_PLUS_YEAR"], "professional_plus"],
    [process.env["STRIPE_PRICE_TEAM"], "team"],
    [process.env["STRIPE_PRICE_TEAM_YEAR"], "team"],
    [process.env["STRIPE_PRICE_ENTERPRISE"], "enterprise"],
    [process.env["STRIPE_PRICE_ENTERPRISE_YEAR"], "enterprise"],
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
