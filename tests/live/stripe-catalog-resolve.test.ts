import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  matchPlanByPrice,
  matchPriceByPlan,
  type CatalogPriceLike,
} from "@/lib/billing/price-catalog";

/**
 * 对着**真实 Stripe 目录**验证价格自解析 —— 真实网络冒烟。
 *
 * 【为什么必须有这一组】
 * 病根 1 的根治手段是 `price-catalog.ts` 的目录自解析:环境变量没配时,
 * 按「产品名关键字 + 金额/周期」从 Stripe 目录实时匹配。它的单元测试
 * (`tests/lib/price-catalog.test.ts`)喂的是手造的价格数组 —— 那些数组
 * 按「我们以为 Stripe 长什么样」造出来的,所以永远和代码自洽。
 *
 * 真实目录里可能:产品被改名、币种不是 hkd、`recurring` 为 null(一次性价格)、
 * `product` 未展开只有 id。任何一条都会让自解析静默返回 null,
 * 于线上表现为「套餐的价格未配置」503 —— 而单元测试全绿。
 *
 * 【与主门禁隔离】
 * 同 `live-slug-check.test.ts`:打真实网络的用例不进 `pnpm verify`。
 * 跑法:`pnpm test:live`。
 *
 * 【没有密钥时跳过而不是红】
 * 这一组要 test 模式密钥才能跑。CI 里没有配 → 跳过。
 * 这与 live-slug-check 的「失败即红」不同,理由:GitHub 是公开可达的,
 * 缺密钥不是环境问题;而 Stripe 目录必须持密钥才能读,
 * 「没配密钥」和「目录真的坏了」是两件事,不该混成同一个红灯。
 *
 * 本地跑法(密钥从 .env.local 自动读,或显式传):
 *   pnpm test:live
 *   STRIPE_SECRET_KEY=sk_test_xxx pnpm test:live
 */

function readSecretKey(): string | null {
  const fromEnv = process.env["STRIPE_SECRET_KEY"]?.trim();
  if (fromEnv) return fromEnv;

  // vitest 不像 Next.js 那样自动加载 .env.local,这里显式找一次
  for (const candidate of [
    resolve(__dirname, "../../.env.local"),
    resolve(process.cwd(), ".env.local"),
  ]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      if (line.startsWith("STRIPE_SECRET_KEY=")) {
        const v = line.slice("STRIPE_SECRET_KEY=".length).trim();
        if (v) return v;
      }
    }
  }
  return null;
}

const SK = readSecretKey();
/** 只允许对 test 账本跑 —— 这组只读,但不该拿 live 密钥做例行冒烟 */
const runnable = Boolean(SK && /^(sk|rk)_test_/.test(SK));

async function fetchCatalog(): Promise<CatalogPriceLike[]> {
  const res = await fetch(
    "https://api.stripe.com/v1/prices?active=true&limit=100&expand[]=data.product",
    { headers: { Authorization: `Bearer ${SK}` } },
  );
  if (!res.ok) {
    throw new Error(`Stripe ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { data: CatalogPriceLike[] };
  return body.data;
}

const CASES = [
  { planId: "professional", interval: "month", amount: 4900 },
  { planId: "professional", interval: "year", amount: 49000 },
  { planId: "enterprise", interval: "month", amount: 22900 },
  { planId: "enterprise", interval: "year", amount: 229000 },
] as const;

describe.skipIf(!runnable)("真实 Stripe 目录 → 价格自解析", () => {
  it("四条 HKD 价格都能从真实目录解析出来", async () => {
    const prices = await fetchCatalog();
    expect(prices.length).toBeGreaterThan(0);

    for (const c of CASES) {
      const id = matchPriceByPlan(c.planId, c.interval, prices);
      expect(
        id,
        `${c.planId}/${c.interval} 在真实目录里没解析出价格 —— ` +
          `线上会表现为「套餐的价格未配置」503。` +
          `检查产品名是否含 professional/专业 或 enterprise/企业,` +
          `以及金额是否为 HKD ${c.amount}。`,
      ).toBeTruthy();

      const hit = prices.find((p) => p.id === id)!;
      expect(hit.currency).toBe("hkd");
      expect(hit.unit_amount).toBe(c.amount);
      expect(hit.recurring?.interval).toBe(c.interval);
    }
  });

  it("反向映射也成立:真实 Price → 正确的 plan_id", async () => {
    const prices = await fetchCatalog();

    for (const c of CASES) {
      const id = matchPriceByPlan(c.planId, c.interval, prices);
      const price = prices.find((p) => p.id === id)!;
      // webhook 走的就是这条:Price → plan。认错套餐 = 付了钱给错权益。
      expect(matchPlanByPrice(price)).toBe(c.planId);
    }
  });

  it("四条价格互不重复 —— 同一个 Price 不该被两个套餐认领", async () => {
    const prices = await fetchCatalog();
    const ids = CASES.map((c) =>
      matchPriceByPlan(c.planId, c.interval, prices),
    );
    expect(new Set(ids).size).toBe(CASES.length);
  });
});

describe.skipIf(runnable)("跳过说明", () => {
  it("没有 test 模式密钥,已跳过目录冒烟", () => {
    // 留一个可见的记录,免得「跳过」被当成「通过」
    expect(runnable).toBe(false);
  });
});
