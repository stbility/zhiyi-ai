import { NextResponse, type NextRequest } from "next/server";

import { z } from "zod";

import { getSiteUrl } from "@/lib/env/server";
import { logger } from "@/lib/log";
import { resolvePriceIdForPlan, getStripe, priceEnvKey } from "@/lib/billing/stripe";
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
  planId: z.enum(["professional", "professional_plus", "team", "enterprise"], "仅支持付费套餐"),
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

  const priceId = resolvePriceIdForPlan(stripe, planId, intervalOrMonth);
  if (!priceId) {
    // 自诊断:env 未配价格 ID 时,把密钥类型前缀写进提示 ——
    // 生产实测教训:sk_test_(测试)密钥查的是空测试目录,会报同样的错,
    // 运维第一眼就该看出「当前密钥是 TEST 模式/不是本账号」。
    const keyPrefix = process.env["STRIPE_SECRET_KEY"]?.slice(0, 8) ?? "?";
    const diag = `当前 STRIPE_SECRET_KEY 前缀 ${keyPrefix}(期望 sk_live_;sk_test_ 测试密钥查的是空测试目录)。`;
    // 变量名必须走 priceEnvKey(PLAN_ENV_CODE)生成 —— 手写 toUpperCase
    // 会拼出 STRIPE_PRICE_PROFESSIONAL / STRIPE_PRICE_ENTERPRISE 这种
    // 不存在的名字,用户照提示配置必然配错(2026-08-13 排查修复)。
    const missingKey = priceEnvKey(planId, intervalOrMonth);
    return NextResponse.json(
      {
        error: `套餐 ${planId}(${intervalOrMonth})的价格未配置。`,
        hint:
          `${diag}${missingKey ?? "STRIPE_PRICE_<CODE>_<MONTH|YEAR>"}` +
          " 未配置(官方做法:显式配置 Price ID;缺失时如实 503,前端降级 Payment Link)。",
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
    // sessionId 一并回给客户端便于排查(付款后 Stripe 会带着同一个 id
    // 回跳 success_url = /billing?session_id={CHECKOUT_SESSION_ID})。
    // 它只是个查询凭据 —— 金额与权益不经 URL 传递,一律以 webhook
    // 收到的 Stripe 事件为准。
    return NextResponse.json({ url: session.url, sessionId: session.id });
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
