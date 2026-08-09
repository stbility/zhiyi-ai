import { describe, expect, it } from "vitest";

import {
  matchPlanByPrice,
  matchPriceByPlan,
  type CatalogPriceLike,
} from "@/lib/billing/price-catalog";

/** 生产实测形状的 4 条 HKD 价格(2026-08-08) */
const REAL_PRICES: readonly CatalogPriceLike[] = [
  { id: "price_1U1t0pPw7bzqE3HKeTv0pOGD", unit_amount: 4900, currency: "hkd", recurring: { interval: "month" }, product: { name: "Professional 专业版" } },
  { id: "price_1U2DBVPw7bzqE3HKS7hrD4DF", unit_amount: 49000, currency: "hkd", recurring: { interval: "year" }, product: { name: "Professional" } },
  { id: "price_1U1t2QPw7bzqE3HKB3GOtFUH", unit_amount: 22900, currency: "hkd", recurring: { interval: "month" }, product: { name: "Enterprise 企业版 · HK$229" } },
  { id: "price_1U2DCpPw7bzqE3HKMlWe5VKw", unit_amount: 229000, currency: "hkd", recurring: { interval: "year" }, product: { name: "企业版" } },
];

describe("Stripe 价格目录匹配(自解析,不再依赖 env)", () => {
  it("plan+interval → Price ID:产品名优先,四条生产价格全命中", () => {
    expect(matchPriceByPlan("professional", "month", REAL_PRICES)).toBe("price_1U1t0pPw7bzqE3HKeTv0pOGD");
    expect(matchPriceByPlan("professional", "year", REAL_PRICES)).toBe("price_1U2DBVPw7bzqE3HKS7hrD4DF");
    expect(matchPriceByPlan("enterprise", "month", REAL_PRICES)).toBe("price_1U1t2QPw7bzqE3HKB3GOtFUH");
    expect(matchPriceByPlan("enterprise", "year", REAL_PRICES)).toBe("price_1U2DCpPw7bzqE3HKMlWe5VKw");
  });

  it("金额+周期兜底:产品未展开(只有 product id)也能命中", () => {
    const unexpanded: readonly CatalogPriceLike[] = [
      { id: "price_x", unit_amount: 4900, currency: "hkd", recurring: { interval: "month" }, product: "prod_123" },
    ];
    expect(matchPriceByPlan("professional", "month", unexpanded)).toBe("price_x");
  });

  it("周期不匹配/金额不对 → 不命中", () => {
    expect(matchPriceByPlan("professional", "year", REAL_PRICES)).not.toBe("price_1U1t0pPw7bzqE3HKeTv0pOGD");
    const wrongAmount: readonly CatalogPriceLike[] = [
      { id: "price_y", unit_amount: 9999, currency: "hkd", recurring: { interval: "month" }, product: { name: "Professional 专业版" } },
    ];
    expect(matchPriceByPlan("professional", "month", wrongAmount)).toBe("price_y"); // 产品名命中,金额不对也认
  });

  it("目录里没有 → null", () => {
    expect(matchPriceByPlan("professional", "month", [])).toBeNull();
  });

  it("Price → plan:产品名与金额兜底两个方向都判对", () => {
    expect(matchPlanByPrice(REAL_PRICES[0]!)).toBe("professional");
    expect(matchPlanByPrice(REAL_PRICES[1]!)).toBe("professional");
    expect(matchPlanByPrice(REAL_PRICES[2]!)).toBe("enterprise");
    expect(matchPlanByPrice(REAL_PRICES[3]!)).toBe("enterprise");
    expect(
      matchPlanByPrice({
        id: "price_z",
        unit_amount: 4900,
        currency: "hkd",
        recurring: { interval: "month" },
        product: null,
      }),
    ).toBe("professional"); // 金额兜底
    expect(
      matchPlanByPrice({
        id: "price_w",
        unit_amount: 123,
        currency: "usd",
        recurring: { interval: "month" },
        product: null,
      }),
    ).toBeNull(); // 认不出 → null(webhook 按 free 降级)
  });
});
