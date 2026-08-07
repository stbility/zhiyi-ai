import "server-only";

import { NextResponse } from "next/server";

import { getStripe, getOrCreateCustomer } from "@/lib/billing/stripe";
import { getSiteUrl } from "@/lib/env/server";
import { getMyOrganizations } from "@/lib/db/queries";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 创建 Checkout Session。
 *
 * 入口约束:
 *   · 必须登录(RLS 客户端取用户身份)
 *   · priceId 必须存在(由前端传入,服务端只透传给 Stripe ——
 *     价格真伪由 Stripe 校验,我们不维护价格表)
 *   · 复用已有 Stripe 客户;没有则先建(映射落 stripe_customers)
 *
 * 返回 { url } 由前端跳转;未配置 Stripe 时返回 503 并如实说明
 * (与全站「未接通如实展示」规则一致,不返回假成功)。
 */
export async function POST(request: Request) {
  const stripe = getStripe();
  if (!stripe) {
    return NextResponse.json(
      { error: "支付通道尚未接通,请稍后再试。" },
      { status: 503 },
    );
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "登录状态不可用。" }, { status: 401 });
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  }

  const { priceId } = (await request.json().catch(() => ({}))) as {
    priceId?: string;
  };
  if (!priceId || typeof priceId !== "string") {
    return NextResponse.json({ error: "缺少 priceId。" }, { status: 400 });
  }

  // 客户映射走 service role —— 用户身份客户端读不到 stripe_customers 的写路径
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "支付服务配置不完整,请联系管理员。" },
      { status: 503 },
    );
  }

  const { customerId, error: customerError } = await getOrCreateCustomer(
    stripe,
    admin,
    user.id,
    user.email ?? undefined,
  );
  if (customerError || !customerId) {
    return NextResponse.json(
      { error: customerError ?? "创建客户失败。" },
      { status: 500 },
    );
  }

  const organizations = await getMyOrganizations();
  const organizationId = organizations[0]?.id;
  const siteUrl = getSiteUrl();

  try {
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      // 订阅来源留痕:organization 用于运营分析,priceId 用于核对
      metadata: {
        userId: user.id,
        ...(organizationId ? { organizationId } : {}),
        priceId,
      },
      success_url: `${siteUrl}/settings/billing?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/settings/billing?canceled=1`,
      // 币种由 Price 决定(港币),这里不指定 currency
      allow_promotion_codes: true,
    });

    return NextResponse.json({ url: session.url });
  } catch {
    // Stripe 错误信息可能含敏感细节,统一兜底,不外泄
    return NextResponse.json({ error: "创建支付会话失败,请稍后再试。" }, { status: 500 });
  }
}
