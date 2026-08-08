import { NextResponse, type NextRequest } from "next/server";

import { z } from "zod";

import { getSiteUrl } from "@/lib/env/server";
import { logger } from "@/lib/log";
import { getPriceIdForPlan, getStripe } from "@/lib/billing/stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 发起订阅 Checkout。
 *
 * 只做两件事:确认套餐 Price 已配置、创建 Checkout Session。
 * 订阅落库**只发生在 webhook**(0033 的写者纪律),本路由不写 subscriptions。
 *
 * 未配置 Stripe 时如实 503,绝不给假的成功路径。
 */

export const dynamic = "force-dynamic";

const checkoutSchema = z.object({
  planId: z.enum(["professional", "enterprise"], "仅支持付费套餐"),
  interval: z.enum(["month", "year"], "仅支持月付/年付").optional(),
});

export async function POST(request: NextRequest) {
  const stripe = getStripe();
  if (!stripe) {
    return NextResponse.json(
      {
        error: "Stripe 未配置。",
        hint: "缺少 STRIPE_SECRET_KEY,配置后订阅才可用。",
      },
      { status: 503 },
    );
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "认证服务未配置。" }, { status: 503 });
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }
  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 },
    );
  }
  const { planId, interval } = parsed.data;
  const intervalOrMonth = interval ?? "month";

  const priceId = getPriceIdForPlan(planId, intervalOrMonth);
  if (!priceId) {
    return NextResponse.json(
      {
        error: `套餐 ${planId}(${intervalOrMonth})的价格未配置。`,
        hint:
          "需要在 Stripe 创建 Price 并在环境变量配置 STRIPE_PRICE_" +
          planId.toUpperCase() +
          (intervalOrMonth === "year" ? "_YEAR" : ""),
      },
      { status: 503 },
    );
  }

  // 客户映射:先查,没有再建。stripe_customers 是 user_id ↔ customer_id 的唯一事实源。
  const { data: customerRow } = await supabase
    .from("stripe_customers")
    .select("customer_id")
    .eq("user_id", user.id)
    .maybeSingle();
  let customerId: string | undefined = customerRow?.customer_id as
    | string
    | undefined;

  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { userId: user.id },
    });
    customerId = customer.id;
    const { error: mapError } = await supabase
      .from("stripe_customers")
      .upsert(
        { user_id: user.id, customer_id: customer.id },
        { onConflict: "user_id" },
      );
    if (mapError) {
      logger.warn(
        { userId: user.id, dbError: mapError.message },
        "客户映射落库失败(不影响本次 checkout)",
      );
    }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      metadata: { userId: user.id, planId, interval: intervalOrMonth },
      subscription_data: {
        metadata: { userId: user.id, planId, interval: intervalOrMonth },
      },
      success_url: `${getSiteUrl()}/billing?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${getSiteUrl()}/billing`,
    });
    if (!session.url) {
      return NextResponse.json({ error: "Stripe 未返回结账地址。" }, { status: 502 });
    }
    return NextResponse.json({ url: session.url });
  } catch (e) {
    logger.error(
      { userId: user.id, planId, error: e instanceof Error ? e.message : String(e) },
      "创建 Checkout Session 失败",
    );
    return NextResponse.json(
      { error: "创建结账会话失败,请稍后重试。" },
      { status: 502 },
    );
  }
}
