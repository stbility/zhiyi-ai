import { NextResponse, type NextRequest } from "next/server";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/log";
import {
  resolvePlanIdForPrice,
  getStripe,
  getStripeConfig,
} from "@/lib/billing/stripe";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Stripe Webhook —— subscriptions 表唯一的写入方(0033 的写者纪律)。
 *
 * 客户端、checkout 路由都不得直接写 subscriptions;订阅状态的任何变化
 * 都以 Stripe 发来的事件为准,幂等 upsert(onConflict stripe_subscription_id)
 * 让重放安全。
 *
 * 套餐判定只认 Price 上的 metadata.plan_id(白名单),
 * 绝不信任客户端传来的 plan 字段。
 */

export const dynamic = "force-dynamic";

const PLAN_WHITELIST = new Set(["professional", "enterprise"]);

async function upsertSubscription(
  admin: SupabaseClient,
  stripe: Stripe,
  subscription: Stripe.Subscription,
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
        const { data: page } = await admin.auth.admin.listUsers({
          page: 1,
          perPage: 1000,
        });
        const match = (page?.users ?? []).find(
          (u) => u.email?.toLowerCase() === email.toLowerCase(),
        );
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
    throw new Error(`无法确定订阅 ${subscription.id} 所属用户`);
  }

  // v22:current_period_end 不在 Subscription 顶层,在 items.data[0] 上。
  const item = subscription.items.data[0];
  const periodEnd = item?.current_period_end ?? null;
  // 套餐判定:price.metadata.plan_id 优先(白名单);生产实测 4 条 HKD 价格
  // metadata 全空 —— 此时用环境变量里的 Price ID 反查,绝不静默降级成 free。
  const pricePlan = item?.price.metadata?.plan_id;
  const planId =
    typeof pricePlan === "string" && PLAN_WHITELIST.has(pricePlan)
      ? pricePlan
      : ((await resolvePlanIdForPrice(stripe, item?.price.id ?? "")) ?? "free");

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

async function setSubscriptionStatus(
  admin: SupabaseClient,
  stripeSubscriptionId: string,
  status: string,
): Promise<void> {
  const { error } = await admin
    .from("subscriptions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("stripe_subscription_id", stripeSubscriptionId);
  if (error) {
    throw new Error(`订阅状态更新失败:${error.message}`);
  }
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
          const subscription = await stripe.subscriptions.retrieve(
            subscriptionId,
          );
          await upsertSubscription(admin, stripe, subscription);
        }
        break;
      }

      case "customer.subscription.updated": {
        await upsertSubscription(
          admin,
          stripe,
          event.data.object as Stripe.Subscription,
        );
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await setSubscriptionStatus(admin, subscription.id, "canceled");
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
