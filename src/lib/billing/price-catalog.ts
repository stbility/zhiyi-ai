/**
 * Stripe 价格目录匹配(纯函数,无 server-only,测试可直接导入)。
 *
 * 背景(2026-08-08):checkout 需要 plan+interval → Price ID,webhook 需要
 * Price ID → plan。此前全靠 4 个环境变量(STRIPE_PRICE_*),用户多次漏配,
 * 线上报「套餐的价格未配置」,支付系统反复修。这里按 Stripe 目录本身匹配:
 *   · 产品名关键字(Professional 专业版 / Enterprise 企业版)
 *   · 金额+周期兜底(实测 4 条 HKD 价格:49/月、490/年、229/月、2290/年)
 * 环境变量仍作快速通道(配了就用),未配时运行时自解析,不再被 env 卡死。
 */

export interface CatalogPriceLike {
  readonly id: string;
  readonly unit_amount: number | null;
  readonly currency: string;
  readonly recurring: { readonly interval: string } | null;
  readonly product?:
    | { readonly name?: string | null }
    | string
    | null;
}

/** 套餐 → 产品名关键字(任一命中即可,英文/中文都认) */
const PLAN_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  professional: ["professional", "专业"],
  enterprise: ["enterprise", "企业"],
};

/** 金额+周期兜底表(HKD,2026-08-08 生产实测) */
const AMOUNT_FALLBACK: readonly {
  readonly planId: string;
  readonly interval: string;
  readonly amount: number;
}[] = [
  { planId: "professional", interval: "month", amount: 4900 },
  { planId: "professional", interval: "year", amount: 49000 },
  { planId: "enterprise", interval: "month", amount: 22900 },
  { planId: "enterprise", interval: "year", amount: 229000 },
];

function productNameOf(
  product: CatalogPriceLike["product"],
): string | null {
  if (!product) return null;
  if (typeof product === "string") return null; // 未展开时只有 product id
  return product.name ?? null;
}

function matchesPlanName(name: string | null, planId: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return PLAN_KEYWORDS[planId]?.some((kw) => lower.includes(kw)) ?? false;
}

/** plan + interval → Price ID。目录里找不到返回 null。 */
export function matchPriceByPlan(
  planId: string,
  interval: string,
  prices: readonly CatalogPriceLike[],
): string | null {
  for (const p of prices) {
    if (!p.recurring || p.recurring.interval !== interval) continue;
    // 产品名优先(身份稳定)
    if (matchesPlanName(productNameOf(p.product), planId)) return p.id;
    // 金额兜底
    const fallback = AMOUNT_FALLBACK.find(
      (f) =>
        f.planId === planId &&
        f.interval === interval &&
        f.amount === p.unit_amount &&
        p.currency === "hkd",
    );
    if (fallback) return p.id;
  }
  return null;
}

/** Price → plan_id。目录里认不出返回 null(webhook 按 free 降级)。 */
export function matchPlanByPrice(price: CatalogPriceLike): string | null {
  const name = productNameOf(price.product);
  for (const planId of ["professional", "enterprise"] as const) {
    if (matchesPlanName(name, planId)) return planId;
  }
  const amount = price.unit_amount;
  if (amount !== null && price.currency === "hkd") {
    const fallback = AMOUNT_FALLBACK.find(
      (f) => f.amount === amount && f.interval === price.recurring?.interval,
    );
    if (fallback) return fallback.planId;
  }
  return null;
}
