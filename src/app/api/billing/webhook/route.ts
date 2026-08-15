import { NextResponse, type NextRequest } from "next/server";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/log";
import {
  resolvePlanIdForPrice,
  getStripe,
  getStripeConfig,
  PLINK_TO_PLAN,
} from "@/lib/billing/stripe";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Stripe Webhook —— subscriptions 表唯一的写入方(0033 的写者纪律)。
 *
 * 客户端、checkout 路由都不得直接写 subscriptions;订阅状态的任何变化
 * 都以 Stripe 为准,幂等 upsert(onConflict stripe_subscription_id)
 * 让重放安全。
 *
 * 套餐判定只认 Price 上的 metadata.plan_id(白名单),
 * 绝不信任客户端传来的 plan 字段。
 *
 * 【事件乱序 —— 曾经会漏钱的地方,别退回去】
 * 官方文档 /webhooks「Event ordering」明说:
 *   "Stripe doesn't guarantee the delivery of events in the order that
 *    they're generated. ... You can also use the API to retrieve any
 *    missing objects."
 * 此前 created/updated 分支直接把 event.data.object 的状态写库。后果:
 *   1. 用户取消 → deleted 先到 → 库里 canceled
 *   2. 一条**更早生成、延迟送达**的 updated(载荷里 status=active)后到
 *   3. 无条件 upsert → 库里被改回 active,且再无事件来纠正
 *   → 该用户不再付费却永久保留付费权益。
 * 现在所有订阅分支一律 fetchAuthoritative() 去 API 拉当前真实状态,
 * 载荷只用于取 id。拉取失败就抛错吃 5xx 让 Stripe 重试,
 * 绝不退回去写可能过期的载荷状态。
 *
 * 残留窗口(已知,可接受):两条事件并发处理时,各自拉到的快照仍可能
 * 后写覆盖先写。窗口从「投递延迟(可达数小时)」缩到「并发处理(毫秒级)」。
 * 要彻底消除需要在 subscriptions 上加事件时间戳列做单调守卫(需迁移)。
 */

export const dynamic = "force-dynamic";

const PLAN_WHITELIST = new Set(["professional", "professional_plus", "team", "enterprise"]);

/**
 * 拿订阅的**权威状态** —— 以 Stripe API 当前返回为准,不信事件载荷。
 *
 * 已取消的订阅 Stripe 依然可 retrieve(返回 status=canceled),
 * 所以 deleted 分支同样走这里,不需要特殊处理。
 */
async function fetchAuthoritative(
  stripe: Stripe,
  subscriptionId: string,
): Promise<Stripe.Subscription> {
  return await stripe.subscriptions.retrieve(subscriptionId);
}

async function upsertSubscription(
  admin: SupabaseClient,
  stripe: Stripe,
  subscription: Stripe.Subscription,
  paymentLink?: string,
): Promise<void> {
  // 归属判定:subscription.metadata.userId 优先(checkout 路由创建时写入);
  // 没有则用 customer 映射反查;再没有则按 Stripe customer 的邮箱
  // 反查 app 用户(覆盖 Payment Link 购买 —— 静态链接无法携带 userId,
  // 但结账邮箱通常与注册邮箱一致)。三条路都拿不到就抛错让 Stripe 重试。
  const metadataUserId = subscription.metadata?.userId;
  let userId: string | undefined = metadataUserId;

  if (!userId) {
    const customerId = subscription.customer as string;
    const { data } = await admin
      .from("stripe_customers")
      .select("user_id")
      .eq("customer_id", customerId)
      .maybeSingle();
    userId = data?.user_id as string | undefined;
  }

  if (!userId) {
    const customerId = subscription.customer as string;
    try {
      const customer = await stripe.customers.retrieve(customerId);
      const email = !customer.deleted
        ? (customer as Stripe.Customer).email
        : undefined;
      if (email) {
        // 【审计修复】不能只扫第一页(1000 人):用户规模一大,第二页起
        // 的订阅就无人认领。分页循环直到命中或取尽(上限 50 页防失控)。
        let match: { id: string } | null = null;
        for (let page = 1; page <= 50; page++) {
          const { data } = await admin.auth.admin.listUsers({
            page,
            perPage: 1000,
          });
          const users = data?.users ?? [];
          match =
            users.find(
              (u) => u.email?.toLowerCase() === email.toLowerCase(),
            ) ?? null;
          if (match || users.length < 1000) break;
        }
        if (match) {
          userId = match.id;
          await admin.from("stripe_customers").upsert(
            { user_id: match.id, customer_id: customerId },
            { onConflict: "user_id" },
          );
        }
      }
    } catch (e) {
      logger.warn(
        { customerId, error: e instanceof Error ? e.message : String(e) },
        "webhook email 归属兜底失败(不影响后续,订阅将重试)",
      );
    }
  }

  if (!userId) {
    // 归属认不出时,若该订阅**已在库**,仍必须把状态落下去 ——
    // 否则「取消」这类事件会因为归属查不到而整条丢失,用户已退订却仍有权益。
    const affected = await setSubscriptionStatus(
      admin,
      subscription.id,
      subscription.status,
    );
    if (affected > 0) {
      logger.warn(
        { subscriptionId: subscription.id, status: subscription.status },
        "订阅归属未能确定,已按 id 更新状态(未改归属)",
      );
      return;
    }
    // 行不存在 → 入账外表(P0-6),返回 200 不再死循环重试:
    // 此前 throw 让 Stripe 重试到放弃,付款与权益永久丢失且无人知晓。
    // 事件已留痕(含付款邮箱),人工可按 docs/payment-loop-runbook.md 补录。
    await recordUnattributed(admin, stripe, subscription, "unknown");
    return;
  }

  // v22:current_period_end 不在 Subscription 顶层,在 items.data[0] 上。
  const item = subscription.items.data[0];
  const periodEnd = item?.current_period_end ?? null;
  // 套餐判定:price.metadata.plan_id 优先(白名单);生产实测 4 条 HKD 价格
  // metadata 全空 —— 此时用环境变量里的 Price ID 反查,绝不静默降级成 free。
  // 2026-08-13(定价 v2):再加 plink 兜底 —— 走 Payment Link 的订阅在
  // checkout.session.completed 里带 session.payment_link,metadata 与 env
  // 都判不出时用它反查(判定顺序:metadata → env → plink → 账外表)。
  const pricePlan = item?.price.metadata?.plan_id;
  const planId =
    (typeof pricePlan === "string" && PLAN_WHITELIST.has(pricePlan)
      ? pricePlan
      : await resolvePlanIdForPrice(stripe, item?.price.id ?? "")) ??
    (paymentLink ? (PLINK_TO_PLAN[paymentLink] ?? null) : null);
  if (!planId) {
    // metadata 与 env 都判不出套餐 → 入账外表(plan_id='unknown')并返回 200:
    // 绝不静默降级 free(静默降级 = 付了钱权益不升,是断链根因),
    // 也绝不 throw 死循环重试(重试到放弃 = 事件永久丢失)。
    // 价格 metadata 缺失是配置问题,账外表比 5xx 重试更有诊断价值。
    // 归属已确认(userId 已知)→ 一并落库,认领时按 UUID 直接追到用户。
    await recordUnattributed(admin, stripe, subscription, "unknown", userId);
    return;
  }

  const { error } = await admin.from("subscriptions").upsert(
    {
      user_id: userId,
      stripe_subscription_id: subscription.id,
      status: subscription.status,
      plan_id: planId,
      current_period_end: periodEnd
        ? new Date(periodEnd * 1000).toISOString()
        : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stripe_subscription_id" },
  );
  if (error) {
    throw new Error(`订阅落库失败:${error.message}`);
  }
}

/**
 * 只改状态,不碰归属。返回**实际命中的行数** ——
 * 调用方据此区分「更新成功」与「这条订阅根本不在库里」。
 * 从前这里是 update-only 且不看命中数:deleted 若比 created 先到
 * (事件不保证顺序),update 匹配 0 行、不报错、不重试,取消就永久丢了。
 */
async function setSubscriptionStatus(
  admin: SupabaseClient,
  stripeSubscriptionId: string,
  status: string,
): Promise<number> {
  const { data, error } = await admin
    .from("subscriptions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .select("stripe_subscription_id");
  if (error) {
    throw new Error(`订阅状态更新失败:${error.message}`);
  }
  return data?.length ?? 0;
}

/**
 * 归属失败入账外表(P0-6):事件留痕,返回 200,人工凭付款邮箱补录。
 *
 * 幂等:以 stripe_subscription_id 为主键 upsert,attempts 递增记录重试次数。
 * 附带读取 Stripe customer 的邮箱 —— 人工认领的唯一线索,读不到也不阻断。
 * userId:可空 —— 归属认不出的行传 undefined(user_id 保持 NULL);
 *   套餐判不出但归属已确认的行传 userId,让账外表能按 auth.uid() UUID 追人。
 * 账外表写入本身失败 → 仍然抛出吃 5xx 让 Stripe 重试(极端情况下
 * 留痕优先于吞掉事件)。
 */
async function recordUnattributed(
  admin: SupabaseClient,
  stripe: Stripe,
  subscription: Stripe.Subscription,
  planId: string,
  userId?: string,
): Promise<void> {
  let customerEmail: string | null = null;
  try {
    const customer = await stripe.customers.retrieve(
      subscription.customer as string,
    );
    if (!customer.deleted) {
      customerEmail = (customer as Stripe.Customer).email ?? null;
    }
  } catch (e) {
    logger.warn(
      { customerId: subscription.customer, error: e instanceof Error ? e.message : String(e) },
      "账外表:读取 customer 邮箱失败(不影响留痕)",
    );
  }

  const { data: existing } = await admin
    .from("unattributed_subscriptions")
    .select("attempts")
    .eq("stripe_subscription_id", subscription.id)
    .maybeSingle();
  const attempts = ((existing?.attempts as number | null) ?? 0) + 1;

  const { error } = await admin.from("unattributed_subscriptions").upsert(
    {
      user_id: userId ?? null,
      stripe_subscription_id: subscription.id,
      customer_id: subscription.customer as string,
      customer_email: customerEmail,
      plan_id: planId,
      status: subscription.status,
      last_event: "webhook",
      attempts,
    },
    { onConflict: "stripe_subscription_id" },
  );
  if (error) {
    logger.error(
      { subscriptionId: subscription.id, dbError: error.message },
      "账外表写入失败(将 5xx 让 Stripe 重试)",
    );
    throw error;
  }
  logger.error(
    {
      subscriptionId: subscription.id,
      customerId: subscription.customer,
      email: customerEmail,
      planId,
      attempts,
    },
    "订阅归属失败,已入账外表待人工认领(见 docs/payment-loop-runbook.md)",
  );
}

export async function POST(request: NextRequest) {
  const config = getStripeConfig();
  const stripe = getStripe();
  if (!stripe || !config?.webhookSecret) {
    return NextResponse.json(
      { error: "Stripe 未配置(webhook 需要 STRIPE_WEBHOOK_SECRET)。" },
      { status: 503 },
    );
  }

  const body = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "缺少 stripe-signature 头。" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, config.webhookSecret);
  } catch (e) {
    logger.warn(
      { error: e instanceof Error ? e.message : String(e) },
      "Stripe webhook 签名校验失败",
    );
    return NextResponse.json({ error: "签名校验失败。" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "服务端数据库未配置。" }, { status: 503 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const subscriptionId = session.subscription;
        if (subscriptionId && typeof subscriptionId === "string") {
          // 客户映射一并补上(幂等),订阅则取最新状态落库
          const sessionUserId = session.metadata?.userId;
          if (sessionUserId && session.customer) {
            await admin.from("stripe_customers").upsert(
              {
                user_id: sessionUserId,
                customer_id: session.customer as string,
              },
              { onConflict: "user_id" },
            );
          }
          const subscription = await fetchAuthoritative(stripe, subscriptionId);
          // 2026-08-13(定价 v2):把 Payment Link ID 传给套餐判定 ——
          // 走 Payment Link 的订阅 Price 可能无 metadata 且 env 未配,
          // 用 PLINK_TO_PLAN 兜底(三级判定:metadata → env → plink)。
          const paymentLink =
            typeof session.payment_link === "string"
              ? session.payment_link
              : undefined;
          await upsertSubscription(admin, stripe, subscription, paymentLink);
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.created":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
      case "customer.subscription.deleted": {
        // 【链路修复】created 与 updated 同处理:Payment Link 新订阅
        // 触发的是 created —— 端点若配了 created 而非 completed,
        // 没有这个分支订阅同样永不落库。
        //
        // paused/resumed 也走这里:0033 的状态白名单含 paused,
        // 官方文档把它们列为**独立事件**(试用期结束无支付方式时触发),
        // 不处理的话被暂停的订阅在库里仍是 active,权益不该留却留着。
        //
        // deleted 同样走这里:已取消的订阅 retrieve 回来就是 canceled,
        // 走同一条 upsert 路径,顺带修掉「行不存在时静默丢失取消」。
        //
        // 五种事件统一取 id 后拉权威状态,**绝不写载荷里的 status** ——
        // 理由见文件顶部「事件乱序」。
        const payload = event.data.object as Stripe.Subscription;
        const subscription = await fetchAuthoritative(stripe, payload.id);
        await upsertSubscription(admin, stripe, subscription);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        // v22:invoice.subscription 字符串字段已移除,改从 parent 链取。
        const subscriptionId =
          invoice.parent?.type === "subscription_details" &&
          invoice.parent.subscription_details &&
          typeof invoice.parent.subscription_details.subscription === "string"
            ? invoice.parent.subscription_details.subscription
            : undefined;
        if (subscriptionId) {
          await setSubscriptionStatus(admin, subscriptionId, "past_due");
        }
        break;
      }
    }
  } catch (e) {
    logger.error(
      { event: event.type, error: e instanceof Error ? e.message : String(e) },
      "Stripe webhook 处理失败",
    );
    // 处理失败返回 5xx,让 Stripe 稍后重试
    return NextResponse.json(
      { error: "处理失败,请重试。" },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true });
}
