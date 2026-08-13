import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { NextRequest } from "next/server";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMemoryAdminClient,
  createMemoryDb,
  type MemoryDb,
} from "../helpers/supabase-memory";

/**
 * Webhook 签名校验的**真实**验证 —— 这里不 mock 密码学。
 *
 * 为什么必须单独一组:
 * `billing-webhook-handler.test.ts` 把 `webhooks.constructEvent` 换成了替身
 * (直接 JSON.parse 请求体)。那组测的是「验签通过之后」的业务分支,
 * 但**真实 HMAC 校验从未被执行过一次**。而签名校验是这个端点唯一的身份守卫:
 * 它若失效,任何人都能 POST 一个 `customer.subscription.updated`
 * 把自己升成 enterprise —— 不需要付一分钱。
 *
 * 这里用真实的 Stripe SDK:
 *   · `webhooks.generateTestHeaderString()` 造**真签名**(官方推荐的测试手法)
 *   · 路由里的 `webhooks.constructEvent()` 做**真校验**(真 HMAC-SHA256 + 时间容差)
 * 只有数据库和「拉权威状态」那次 API 调用是替身。
 *
 * 事件载荷用的是 `tests/fixtures/stripe-subscription.test-mode.json` ——
 * 从**真实 Stripe test 账本**抓下来的订阅对象(2026-08-09,一笔 HKD 4900
 * 测试卡付款产生的真实订阅),不是手造的。手造 fixture 永远和代码自洽,
 * 结构假设错了也测不出来;这份来自真实对象,Stripe 改结构它就会红。
 */

vi.mock("server-only", () => ({}));

const FIXTURE = JSON.parse(
  readFileSync(
    resolve(__dirname, "../fixtures/stripe-subscription.test-mode.json"),
    "utf8",
  ),
) as Record<string, unknown>;

// Webhook 验签密钥。
//
// 签名与验签只要求「同一个值」,Stripe SDK 不校验密钥格式 —— 所以测试
// 用运行期生成的随机串,源码里不出现任何形如 whsec_ / sk_ 的字符串
// (写死的「看起来像密钥」的值会被 Secret scanning 当作泄露告警)。
// 若需要复现线上验签(比如抓了生产事件调试),用
//   STRIPE_WEBHOOK_SECRET=whsec_... pnpm test -- tests/app/billing-webhook-signature.test.ts
// 从环境变量注入,而不是写进文件。
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? randomUUID();

/** 只用它的 webhooks 模块 —— constructEvent / generateTestHeaderString 不需要有效密钥 */
const realStripe = new Stripe(randomUUID(), {
  apiVersion: "2026-06-24.dahlia",
});

let db: MemoryDb = createMemoryDb();

const state = {
  /** 「拉权威状态」这一次 API 调用的返回值 */
  authoritative: FIXTURE,
  retrieveCalls: 0,
};

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => createMemoryAdminClient(db),
}));

vi.mock("@/lib/billing/stripe", () => ({
  getStripe: () => ({
    // 真实实现 —— 本文件的全部意义所在
    webhooks: realStripe.webhooks,
    subscriptions: {
      retrieve: async () => {
        state.retrieveCalls += 1;
        return state.authoritative;
      },
    },
    customers: { retrieve: async () => ({ deleted: true }) },
  }),
  getStripeConfig: () => ({
    secretKey: randomUUID(),
    publishableKey: "",
    webhookSecret: WEBHOOK_SECRET,
  }),
  resolvePlanIdForPrice: async () => null,
}));

vi.mock("@/lib/log", () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {} },
}));

function eventBody(type: string, object: unknown): string {
  return JSON.stringify({
    id: "evt_signature_test",
    object: "event",
    type,
    data: { object },
  });
}

/** 造一个带**真签名**的请求 */
function signedPost(
  body: string,
  opts: { secret?: string; timestamp?: number; sendBody?: string } = {},
): NextRequest {
  const header = realStripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: opts.secret ?? WEBHOOK_SECRET,
    ...(opts.timestamp === undefined ? {} : { timestamp: opts.timestamp }),
  });
  return new NextRequest("https://x.test/api/billing/webhook", {
    method: "POST",
    body: opts.sendBody ?? body,
    headers: { "stripe-signature": header },
  });
}

async function handler() {
  const mod = await import("@/app/api/billing/webhook/route");
  return mod.POST;
}

beforeEach(() => {
  vi.resetModules();
  db = createMemoryDb();
  state.authoritative = FIXTURE;
  state.retrieveCalls = 0;
});

describe("真实 HMAC 签名校验(不 mock 密码学)", () => {
  it("正确签名 → 200,并按真实载荷结构落库", async () => {
    const body = eventBody("customer.subscription.created", FIXTURE);
    const POST = await handler();
    const res = await POST(signedPost(body));

    expect(res.status).toBe(200);
    expect(db.subscriptions).toHaveLength(1);

    const item = (
      (FIXTURE["items"] as { data: Record<string, unknown>[] }).data[0]
    ) as Record<string, unknown>;
    expect(db.subscriptions[0]).toMatchObject({
      stripe_subscription_id: FIXTURE["id"],
      status: FIXTURE["status"],
      plan_id: "professional",
      current_period_end: new Date(
        (item["current_period_end"] as number) * 1000,
      ).toISOString(),
    });
  });

  it("请求体被篡改 → 400。这是「不付钱也能升级」的唯一拦阻", async () => {
    const honest = eventBody("customer.subscription.created", FIXTURE);
    // 攻击者拿一个合法签名,换掉请求体想把自己升成 enterprise
    const tampered = eventBody("customer.subscription.created", {
      ...FIXTURE,
      metadata: { userId: "attacker" },
    });

    const POST = await handler();
    const res = await POST(signedPost(honest, { sendBody: tampered }));

    expect(res.status).toBe(400);
    expect(db.subscriptions).toHaveLength(0);
  });

  it("用错误的 secret 签名 → 400", async () => {
    const body = eventBody("customer.subscription.created", FIXTURE);
    const POST = await handler();
    const res = await POST(signedPost(body, { secret: randomUUID() }));

    expect(res.status).toBe(400);
    expect(db.subscriptions).toHaveLength(0);
  });

  it("时间戳过期 → 400(重放旧请求挡在门外)", async () => {
    const body = eventBody("customer.subscription.created", FIXTURE);
    // 默认容差 300 秒,给一个 1 小时前的时间戳
    const anHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const POST = await handler();
    const res = await POST(signedPost(body, { timestamp: anHourAgo }));

    expect(res.status).toBe(400);
    expect(db.subscriptions).toHaveLength(0);
  });

  it("签名通过后仍去拉权威状态(乱序防护不因验签而放松)", async () => {
    const body = eventBody("customer.subscription.updated", FIXTURE);
    const POST = await handler();
    await POST(signedPost(body));
    expect(state.retrieveCalls).toBeGreaterThan(0);
  });
});

describe("golden fixture 结构守卫(Stripe 改结构就该红)", () => {
  it("current_period_end 在 items.data[0] 上,**不在**订阅顶层", async () => {
    // 这两条正是 v22 的破坏性变更。抓 fixture 时对着真实对象验过一次,
    // 这里把它固定成断言 —— 将来重抓 fixture 若结构变了,立刻可见。
    expect(FIXTURE["current_period_end"]).toBeUndefined();
    const item = (FIXTURE["items"] as { data: Record<string, unknown>[] })
      .data[0]!;
    expect(typeof item["current_period_end"]).toBe("number");
  });

  it("price.metadata.plan_id 存在且在白名单内", async () => {
    const item = (FIXTURE["items"] as { data: Record<string, unknown>[] })
      .data[0]!;
    const price = item["price"] as { metadata?: Record<string, string> };
    expect(["professional", "enterprise"]).toContain(
      price.metadata?.["plan_id"],
    );
  });

  it("customer 是字符串 id —— 路由里的 as string 断言成立", async () => {
    expect(typeof FIXTURE["customer"]).toBe("string");
  });
});
