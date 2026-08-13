import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stripe webhook 路由的**真实执行**测试。
 *
 * 为什么这个文件必须存在:
 * 在此之前,支付相关的测试全部是静态源码断言(readFileSync + toContain)——
 * 检查的是「SQL 文件里写了这句话」「plans.ts 里有这个字符串」。
 * `src/app/api/billing/{checkout,webhook,portal}/route.ts` 的实际代码
 * **一行都没有被执行过**。
 * 于是 935 个绿灯并不能证明钱变得成权益;它只证明源码里写了那些字。
 *
 * 这里用替身 Stripe + 内存版 Supabase,真正调用 `POST()`,
 * 断言的是**行为**:什么进了库、什么被拒绝、什么让 Stripe 重试。
 *
 * 头号目标是钉死一类**只在事件乱序时才出现、真实支付测试大概率碰不到**的缺陷:
 * 官方文档 /webhooks「Event ordering」明说 Stripe 不保证事件按生成顺序送达。
 * 一条延迟送达的旧 `customer.subscription.updated`(载荷 status=active)
 * 若被无条件写库,就能把一个已取消的订阅改回 active —— 用户不再付费
 * 却永久保留付费权益,且再也不会有事件来纠正。
 */

import {
  createMemoryAdminClient,
  createMemoryDb,
  type MemoryDb,
  type Row,
} from "../helpers/supabase-memory";

vi.mock("server-only", () => ({}));

/** 内存版 Supabase —— 见 tests/helpers/supabase-memory.ts */
let db: MemoryDb = createMemoryDb();

// 测试密钥一律运行期生成(node:crypto randomUUID):签名算法只要求
// 「签名与验签用同一个值」,不校验格式。刻意不在源码里写任何形如
// whsec_ / sk_ 的字符串 —— 写死的「看起来像密钥」的值会被 Secret
// scanning 当作泄露告警(2026-08-13 清理)。
const stripeState = {
  configured: true,
  webhookSecret: randomUUID(),
  /** false 时 constructEvent 抛错,模拟伪造/篡改的请求 */
  signatureValid: true,
  /** Stripe 侧的**权威状态** —— 与事件载荷刻意分开,才能测出「信谁」 */
  subscriptions: new Map<string, Row>(),
  customers: new Map<string, Row>(),
  retrieveThrows: false,
  planByPrice: {} as Record<string, string>,
  /** 路由是否去 API 拉了权威状态(P0 修复的核心行为) */
  retrieveCalls: 0,
};

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => createMemoryAdminClient(db),
}));

const fakeStripe = {
  webhooks: {
    constructEvent: (body: string) => {
      if (!stripeState.signatureValid) throw new Error("签名不匹配");
      return JSON.parse(body);
    },
  },
  subscriptions: {
    retrieve: async (id: string) => {
      stripeState.retrieveCalls += 1;
      if (stripeState.retrieveThrows) throw new Error("Stripe 暂时不可用");
      const s = stripeState.subscriptions.get(id);
      if (!s) throw new Error(`no such subscription: ${id}`);
      return s;
    },
  },
  customers: {
    retrieve: async (id: string) =>
      stripeState.customers.get(id) ?? { deleted: true },
  },
};

vi.mock("@/lib/billing/stripe", () => ({
  getStripe: () => (stripeState.configured ? fakeStripe : null),
  getStripeConfig: () =>
    stripeState.configured
      ? {
          secretKey: randomUUID(),
          publishableKey: "",
          webhookSecret: stripeState.webhookSecret,
        }
      : null,
  resolvePlanIdForPrice: async (_s: unknown, priceId: string) =>
    stripeState.planByPrice[priceId] ?? null,
}));

vi.mock("@/lib/log", () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {} },
}));

const USER = "11111111-1111-4111-8111-111111111111";
const SUB = "sub_test_1";
const CUS = "cus_test_1";
const PRICE_PRO = "price_pro_month";

/** 造一个订阅对象。载荷与权威状态用同一个工厂,但可以给不同的 status。 */
function subscription(over: Partial<Row> = {}, priceId = PRICE_PRO): Row {
  return {
    id: SUB,
    status: "active",
    customer: CUS,
    cancel_at_period_end: false,
    metadata: { userId: USER },
    items: {
      data: [
        {
          current_period_end: 1_800_000_000,
          price: { id: priceId, metadata: { plan_id: "professional" } },
        },
      ],
    },
    ...over,
  };
}

function event(type: string, object: unknown): Row {
  return { id: "evt_test_1", type, data: { object } };
}

function post(evt: unknown, withSignature = true): NextRequest {
  // exactOptionalPropertyTypes:headers 不能显式传 undefined,只能不带这个键。
  // 用条件展开而非先声明后赋值 —— NextRequest 的 RequestInit 与 DOM 的不同名。
  return new NextRequest("https://x.test/api/billing/webhook", {
    method: "POST",
    body: JSON.stringify(evt),
    ...(withSignature
      ? { headers: { "stripe-signature": "t=1,v1=deadbeef" } }
      : {}),
  });
}

async function handler() {
  const mod = await import("@/app/api/billing/webhook/route");
  return mod.POST;
}

beforeEach(() => {
  vi.resetModules();
  db = createMemoryDb();
  stripeState.configured = true;
  stripeState.signatureValid = true;
  stripeState.subscriptions = new Map();
  stripeState.customers = new Map();
  stripeState.retrieveThrows = false;
  stripeState.planByPrice = {};
  stripeState.retrieveCalls = 0;
});

describe("webhook 安全姿态(这些分支必须真的跑过)", () => {
  it("没有 stripe-signature 头 → 400,绝不处理", async () => {
    const POST = await handler();
    const res = await POST(post(event("customer.subscription.updated", subscription()), false));
    expect(res.status).toBe(400);
    expect(db.subscriptions).toHaveLength(0);
  });

  it("签名校验失败 → 400,一个字节都不入库", async () => {
    stripeState.signatureValid = false;
    stripeState.subscriptions.set(SUB, subscription());
    const POST = await handler();
    const res = await POST(post(event("customer.subscription.updated", subscription())));
    expect(res.status).toBe(400);
    expect(db.subscriptions).toHaveLength(0);
  });

  it("Stripe 未配置 → 503,如实说没配,不伪装成功", async () => {
    stripeState.configured = false;
    const POST = await handler();
    const res = await POST(post(event("customer.subscription.updated", subscription())));
    expect(res.status).toBe(503);
  });
});

describe("【P0 回归】事件乱序不得让已取消的订阅复活", () => {
  it("库里已 canceled 时,延迟送达的旧 updated(载荷 active)不得改回 active", async () => {
    // Stripe 侧权威状态:这个订阅确实已经取消了
    stripeState.subscriptions.set(SUB, subscription({ status: "canceled" }));
    // 库里已经落了 canceled(deleted 事件先到并已处理完)
    db.subscriptions.push({
      user_id: USER,
      stripe_subscription_id: SUB,
      status: "canceled",
      plan_id: "professional",
    });

    // 现在才收到那条**更早生成、延迟送达**的 updated —— 载荷里写着 active
    const stalePayload = subscription({ status: "active" });
    const POST = await handler();
    const res = await POST(post(event("customer.subscription.updated", stalePayload)));

    expect(res.status).toBe(200);
    // 关键断言:以 Stripe 权威状态为准,不是载荷
    expect(db.subscriptions[0]?.["status"]).toBe("canceled");
  });

  it("处理订阅事件时必须去 API 拉权威状态,而不是直接用载荷", async () => {
    stripeState.subscriptions.set(SUB, subscription({ status: "canceled" }));
    const POST = await handler();
    await POST(post(event("customer.subscription.updated", subscription({ status: "active" }))));
    // 这条断言防的是「有人图省事改回直接写 event.data.object」
    expect(stripeState.retrieveCalls).toBeGreaterThan(0);
  });

  it("deleted 比 created 先到时,取消不得静默丢失(此前 update 匹配 0 行就没了)", async () => {
    stripeState.subscriptions.set(SUB, subscription({ status: "canceled" }));
    // 库里此刻还没有这条订阅
    expect(db.subscriptions).toHaveLength(0);

    const POST = await handler();
    const res = await POST(post(event("customer.subscription.deleted", subscription({ status: "canceled" }))));

    expect(res.status).toBe(200);
    expect(db.subscriptions).toHaveLength(1);
    expect(db.subscriptions[0]?.["status"]).toBe("canceled");
  });

  it("拉取权威状态失败 → 500 让 Stripe 重试,绝不退回去写可能过期的载荷", async () => {
    stripeState.subscriptions.set(SUB, subscription({ status: "canceled" }));
    stripeState.retrieveThrows = true;
    const POST = await handler();
    const res = await POST(post(event("customer.subscription.updated", subscription({ status: "active" }))));
    expect(res.status).toBe(500);
    expect(db.subscriptions).toHaveLength(0);
  });
});

describe("订阅落库", () => {
  it("checkout.session.completed → 订阅落库 + 客户映射一并补上", async () => {
    stripeState.subscriptions.set(SUB, subscription());
    const POST = await handler();
    const res = await POST(
      post(
        event("checkout.session.completed", {
          subscription: SUB,
          customer: CUS,
          metadata: { userId: USER },
        }),
      ),
    );

    expect(res.status).toBe(200);
    expect(db.stripe_customers).toEqual([
      { user_id: USER, customer_id: CUS },
    ]);
    expect(db.subscriptions[0]).toMatchObject({
      user_id: USER,
      stripe_subscription_id: SUB,
      status: "active",
      plan_id: "professional",
      cancel_at_period_end: false,
    });
  });

  it("paused 事件被处理 —— 否则被暂停的订阅在库里仍是 active,权益不该留却留着", async () => {
    stripeState.subscriptions.set(SUB, subscription({ status: "paused" }));
    const POST = await handler();
    const res = await POST(post(event("customer.subscription.paused", subscription({ status: "paused" }))));
    expect(res.status).toBe(200);
    expect(db.subscriptions[0]?.["status"]).toBe("paused");
  });

  it("重复投递同一事件不产生第二行(幂等 upsert,重放安全)", async () => {
    stripeState.subscriptions.set(SUB, subscription());
    const POST = await handler();
    await POST(post(event("customer.subscription.created", subscription())));
    await POST(post(event("customer.subscription.created", subscription())));
    expect(db.subscriptions).toHaveLength(1);
  });

  it("current_period_end 从 items.data[0] 取(v22 已不在订阅顶层)", async () => {
    stripeState.subscriptions.set(SUB, subscription());
    const POST = await handler();
    await POST(post(event("customer.subscription.created", subscription())));
    expect(db.subscriptions[0]?.["current_period_end"]).toBe(
      new Date(1_800_000_000 * 1000).toISOString(),
    );
  });
});

describe("套餐判定 —— 绝不信客户端,只认 Price", () => {
  it("price.metadata.plan_id 在白名单内 → 直接采信", async () => {
    stripeState.subscriptions.set(SUB, subscription());
    const POST = await handler();
    await POST(post(event("customer.subscription.created", subscription())));
    expect(db.subscriptions[0]?.["plan_id"]).toBe("professional");
  });

  it("metadata 为空(生产实测过的情况)→ 回落到目录解析,不静默降级成 free", async () => {
    const noMeta = subscription({}, "price_no_meta");
    (noMeta["items"] as { data: { price: { metadata: Row } }[] }).data[0]!.price.metadata = {};
    stripeState.subscriptions.set(SUB, noMeta);
    stripeState.planByPrice["price_no_meta"] = "enterprise";

    const POST = await handler();
    await POST(post(event("customer.subscription.created", noMeta)));
    expect(db.subscriptions[0]?.["plan_id"]).toBe("enterprise");
  });

  it("metadata 里塞了白名单外的套餐 → 不采信,走目录解析", async () => {
    const evil = subscription({}, "price_evil");
    (evil["items"] as { data: { price: { metadata: Row } }[] }).data[0]!.price.metadata = {
      plan_id: "free_but_actually_enterprise",
    };
    stripeState.subscriptions.set(SUB, evil);
    stripeState.planByPrice["price_evil"] = "professional";

    const POST = await handler();
    await POST(post(event("customer.subscription.created", evil)));
    expect(db.subscriptions[0]?.["plan_id"]).toBe("professional");
  });

  it("目录也认不出 → 如实 500 重试,绝不静默降级 free(2026-08-10 #54 语义)", async () => {
    // 代理原断言「→ free,不抛错」—— 静默降级 free = 付了钱权益不升,
    // 正是断链病根(用户多轮投诉)。#54 起:metadata 与 env 都判不出套餐 →
    // 如实 500(Stripe 重试),不落库,配置好 STRIPE_PRICE_* 后自动恢复。
    const unknown = subscription({}, "price_unknown");
    (unknown["items"] as { data: { price: { metadata: Row } }[] }).data[0]!.price.metadata = {};
    stripeState.subscriptions.set(SUB, unknown);

    const POST = await handler();
    const res = await POST(post(event("customer.subscription.created", unknown)));
    expect(res.status).toBe(500);
    expect(db.subscriptions[0]).toBeUndefined();
  });
});

describe("归属判定(Payment Link 买的订阅没有 metadata.userId)", () => {
  it("没有 metadata.userId → 用 stripe_customers 映射反查", async () => {
    stripeState.subscriptions.set(SUB, subscription({ metadata: {} }));
    db.stripe_customers.push({ user_id: USER, customer_id: CUS });

    const POST = await handler();
    await POST(post(event("customer.subscription.created", subscription({ metadata: {} }))));
    expect(db.subscriptions[0]?.["user_id"]).toBe(USER);
  });

  it("映射也没有 → 按 Stripe 客户邮箱反查 app 用户,并补上映射", async () => {
    stripeState.subscriptions.set(SUB, subscription({ metadata: {} }));
    stripeState.customers.set(CUS, { id: CUS, email: "Buyer@Example.com" });
    db.users.push({ id: USER, email: "buyer@example.com" });

    const POST = await handler();
    await POST(post(event("customer.subscription.created", subscription({ metadata: {} }))));

    expect(db.subscriptions[0]?.["user_id"]).toBe(USER);
    // 反查成功后要把映射补上,下次不必再扫用户表
    expect(db.stripe_customers).toEqual([{ user_id: USER, customer_id: CUS }]);
  });

  it("三条路都查不到、且订阅不在库 → 500 让 Stripe 重试,绝不猜一个用户", async () => {
    stripeState.subscriptions.set(SUB, subscription({ metadata: {} }));
    stripeState.customers.set(CUS, { id: CUS, email: "nobody@example.com" });

    const POST = await handler();
    const res = await POST(post(event("customer.subscription.created", subscription({ metadata: {} }))));
    expect(res.status).toBe(500);
    expect(db.subscriptions).toHaveLength(0);
  });

  it("归属查不到但订阅已在库 → 仍要把状态落下去(否则退订会整条丢失)", async () => {
    stripeState.subscriptions.set(SUB, subscription({ status: "canceled", metadata: {} }));
    stripeState.customers.set(CUS, { id: CUS, email: "nobody@example.com" });
    db.subscriptions.push({
      user_id: USER,
      stripe_subscription_id: SUB,
      status: "active",
      plan_id: "professional",
    });

    const POST = await handler();
    const res = await POST(post(event("customer.subscription.deleted", subscription({ status: "canceled", metadata: {} }))));

    expect(res.status).toBe(200);
    expect(db.subscriptions[0]?.["status"]).toBe("canceled");
    // 归属没变,只改状态
    expect(db.subscriptions[0]?.["user_id"]).toBe(USER);
  });
});
