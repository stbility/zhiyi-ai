import "server-only";

import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { getStripe, ALLOWED_PLAN_IDS } from "@/lib/billing/stripe";
import { getServerEnv } from "@/lib/env/server";
import { logger } from "@/lib/log";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe Webhook —— 订阅状态的唯一写路径。
 *
 * 【为什么订阅状态只在这里写】
 *   用户自己改 subscriptions 表 = 伪造权益。0033 迁移为此没有给用户
 *   任何 INSERT/UPDATE/DELETE 策略 —— 连 RLS 兜底都不需要,
 *   表结构上就不存在这个入口。webhook 用 service role 写入,
 *   是唯一合法的写路径。
 *
 * 【验签】
 *   STRIPE_WEBHOOK_SECRET 用于校验签名。验签失败 = 请求不是来自 Stripe,
 *   必须拒绝(400)。这是「伪造付款成功」攻击的防线。
 *
 * 【幂等】
 *   同一订阅的重复事件(stripe 会重试)用 stripe_subscription_id 唯一约束
 *   兜底:upsert 保证同一订阅只生效一次。
 *
 * 【事件处理】
 *   checkout.session.completed      —— 订阅刚创建,同步状态
 *   customer.subscription.updated   —— 续费/升降级/取消(cancel_at_period_end)
 *   customer.subscription.deleted   —— 到期取消,状态落 canceled
 *   invoice.payment_failed          —— 续费失败,标记 past_due(权益保留到 period_end)
 */
export async function POST(request: Request) {
  const stripe = getStripe();
  const secret = getServerEnv().STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    logger.warn({ app: "zhiyi-ai" }, "stripe webhook: 未配置,拒绝请求");
    return NextResponse.json(
      { error: "webhook 未配置" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "缺少签名" }, { status: 400 });
  }

  const body = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch {
    // 签名不对 = 伪造请求,直接拒绝,不落任何日志细节
    return NextResponse.json({ error: "签名校验失败" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    logger.error({ app: "zhiyi-ai" }, "stripe webhook: service role 未配置");
    return NextResponse.json(
      { error: "数据库写入通道未配置" },
      { status: 503 },
    );
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode !== "subscription" || !session.subscription) break;

      const userId = session.metadata?.userId;
      const customerId = session.customer;
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription.id;
      if (!userId || !customerId || !subscriptionId) {
        logger.warn(
          { app: "zhiyi-ai", eventId: event.id },
          "checkout.session.completed: 缺 metadata.userId / customer / subscription,跳过",
        );
        break;
      }

      // 客户映射可能已由 checkout 路由创建;这里幂等补齐
      await admin
        .from("stripe_customers")
        .upsert({ user_id: userId, customer_id: String(customerId) });

      // 订阅状态查询 Stripe(拿 plan_id 与 period_end)
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const planId = planIdFromSubscription(subscription);
      if (!planId) {
        logger.error(
          { app: "zhiyi-ai", subscriptionId },
          "checkout.session.completed: 无法从 Price metadata 识别 plan_id",
        );
        break;
      }

      await upsertSubscription(admin, {
        userId,
        stripeSubscriptionId: subscriptionId,
        status: subscription.status,
        planId,
        currentPeriodEnd: subscription.items.data[0]?.current_period_end
          ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString()
          : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      });
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object;
      const userId = await findUserIdBySubscription(admin, subscription.id);
      if (!userId) {
        // 订阅更新但本地没有映射 —— 说明建订阅时 webhook 没同步到。
        // 从 Stripe 客户反查:customer → stripe_customers → user_id
        const mapped = await admin
          .from("stripe_customers")
          .select("user_id")
          .eq("customer_id", String(subscription.customer))
          .maybeSingle();
        if (!mapped.data?.user_id) {
          logger.warn(
            { app: "zhiyi-ai", subscriptionId: subscription.id },
            "subscription.updated: 找不到对应用户,跳过",
          );
          break;
        }
        await upsertSubscription(admin, {
          userId: mapped.data.user_id as string,
          stripeSubscriptionId: subscription.id,
          status: subscription.status,
          planId: planIdFromSubscription(subscription) ?? "free",
          currentPeriodEnd: subscription.items.data[0]?.current_period_end
            ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString()
            : null,
          cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
        });
        break;
      }

      await upsertSubscription(admin, {
        userId,
        stripeSubscriptionId: subscription.id,
        status: subscription.status,
        planId: planIdFromSubscription(subscription) ?? "free",
        currentPeriodEnd: subscription.items.data[0]?.current_period_end
          ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString()
          : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      });
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const userId = await findUserIdBySubscription(admin, subscription.id);
      if (!userId) break;

      await admin
        .from("subscriptions")
        .update({ status: "canceled", updated_at: new Date().toISOString() })
        .eq("stripe_subscription_id", subscription.id);
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      // v22: invoice 的 subscription 关联在 parent.subscription_details 里
      const subscriptionId =
        invoice.parent?.type === "subscription_details" &&
        invoice.parent.subscription_details
          ? invoice.parent.subscription_details.subscription
          : undefined;
      const subscriptionIdStr =
        typeof subscriptionId === "string" ? subscriptionId : undefined;
      if (!subscriptionIdStr) break;

      await admin
        .from("subscriptions")
        .update({ status: "past_due", updated_at: new Date().toISOString() })
        .eq("stripe_subscription_id", subscriptionIdStr);
      break;
    }

    default:
      // 其余事件(如 invoice.paid)不关心 —— 显式静默,不算错误
      break;
  }

  // 无论处理结果如何都回 200 —— Stripe 会重试非 2xx,
  // 而我们的幂等设计保证重复投递安全
  return NextResponse.json({ received: true });
}

// ─── 内部工具 ───────────────────────────────────────────────────────────────

/** 从 Stripe 订阅的 Price metadata 取 plan_id(白名单校验) */
function planIdFromSubscription(
  subscription: Stripe.Subscription,
): string | null {
  const price =
    subscription.items.data[0]?.price ??
    subscription.items.data[0]?.plan;
  const planId = price?.metadata?.plan_id;
  if (!planId) return null;
  return ALLOWED_PLAN_IDS.includes(
    planId as (typeof ALLOWED_PLAN_IDS)[number],
  )
    ? planId
    : null;
}

/** 按 stripe_subscription_id 找 user_id(幂等去重的依据) */
async function findUserIdBySubscription(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  subscriptionId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("subscriptions")
    .select("user_id")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();
  return data?.user_id ? (data.user_id as string) : null;
}

/** upsert 订阅状态 —— 同一订阅只保留一条记录 */
async function upsertSubscription(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  row: {
    userId: string;
    stripeSubscriptionId: string;
    status: string;
    planId: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  },
): Promise<void> {
  const { error } = await admin.from("subscriptions").upsert(
    {
      user_id: row.userId,
      stripe_subscription_id: row.stripeSubscriptionId,
      status: row.status,
      plan_id: row.planId,
      current_period_end: row.currentPeriodEnd,
      cancel_at_period_end: row.cancelAtPeriodEnd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stripe_subscription_id" },
  );
  if (error) {
    logger.error(
      { app: "zhiyi-ai", subscriptionId: row.stripeSubscriptionId },
      `stripe webhook: 订阅落库失败 ${error.message}`,
    );
  }
}
