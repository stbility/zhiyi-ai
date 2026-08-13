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
 * metadata.plan_id ∈ {professional, professional_plus, team, enterprise}
 * —— webhook 据此判定套餐,绝不信任客户端传来的 plan 字段。
 *
 * interval:month(默认)读 STRIPE_PRICE_<CODE>_MONTH,year 读
 * STRIPE_PRICE_<CODE>_YEAR。CODE 见 PLAN_ENV_CODE —— 正向(checkout)
 * 与反向(webhook)必须用同一张表,任何一处另写一份 key 都会分叉
 * (2026-08-13 修:此前正向生成 STRIPE_PRICE_ENTERPRISE_*、反向查
 * STRIPE_PRICE_ENT_*,配置 STRIPE_PRICE_ENT_MONTH 后 checkout 依旧报
 * 「价格未配置」503)。
 * 未配置返回 null,由调用方如实降级(503 + 提示),绝不伪造成功路径。
 */
const PLAN_ENV_CODE: Readonly<Record<string, string>> = {
  professional: "PRO",
  professional_plus: "PRO_PLUS",
  team: "TEAM",
  enterprise: "ENT",
};

export function priceEnvKey(
  planId: string,
  interval: "month" | "year" = "month",
): string | null {
  const code = PLAN_ENV_CODE[planId];
  if (!code) return null;
  return `STRIPE_PRICE_${code}${interval === "year" ? "_YEAR" : "_MONTH"}`;
}

export function getPriceIdForPlan(
  planId: string,
  interval: "month" | "year" = "month",
): string | null {
  const key = priceEnvKey(planId, interval);
  if (!key) return null;
  return process.env[key]?.trim() ?? null;
}

/**
 * Price ID → plan_id 反向映射(webhook 用)。
 *
 * 生产实测(2026-08-08):4 条 HKD 价格(月/年 × Pro/Ent)的 metadata 全为空,
 * webhook 只认 price.metadata.plan_id 会把所有订阅静默降级成 free ——
 * 用户付了钱权益不变。这里用环境变量里的 Price ID 兜底映射,
 * metadata 缺失时也能判对套餐;两处都配齐时以 metadata 为准。
 *
 * 候选 key 与正向(getPriceIdForPlan)共用 PLAN_ENV_CODE,
 * 保证 checkout 配什么、webhook 就认什么。
 */
export function getPlanIdForPrice(priceId: string): string | null {
  for (const [planId, code] of Object.entries(PLAN_ENV_CODE)) {
    const month = process.env[`STRIPE_PRICE_${code}_MONTH`]?.trim();
    const year = process.env[`STRIPE_PRICE_${code}_YEAR`]?.trim();
    if (month === priceId || year === priceId) return planId;
  }
  return null;
}

/**
 * plan + interval → Price ID(官方做法 = 环境变量显式配置)。
 *
 * 2026-08-10 清理:移除「目录自解析」(price-catalog)——不配 id 也能跑
 * 会把 STRIPE_PRICE_* 缺失伪装成可用,是错误做法;官方做法是显式配置,
 * 未配则返回 null,调用方如实 503(降级 Payment Link)。
 *
 * 2026-08-11:同步化 —— 内部只读环境变量,不需要 async/await。
 */
export function resolvePriceIdForPlan(
  _stripe: Stripe,
  planId: string,
  interval: "month" | "year",
): string | null {
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
