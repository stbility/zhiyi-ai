import "server-only";

import { NextResponse } from "next/server";

import { getStripe, getOrCreateCustomer } from "@/lib/billing/stripe";
import { getSiteUrl } from "@/lib/env/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 创建 Billing Portal Session(账单门户)。
 *
 * 用户在门户里可以:改卡、看发票、取消订阅(到期生效)、重新订阅。
 * 与 checkout 同构:登录 → 取/建客户 → 创建 session → 返回 url。
 *
 * 门户是 Stripe 托管页面,我们不渲染任何账单 UI ——
 * 比自建账单页省一个量级的开发量,且永远和 Stripe 状态一致。
 */
export async function POST() {
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

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${getSiteUrl()}/settings/billing`,
    });
    return NextResponse.json({ url: session.url });
  } catch {
    // 不泄漏 Stripe 内部细节 —— 用户看到的应是可行动的提示
    return NextResponse.json(
      { error: "无法打开账单门户,请稍后再试。" },
      { status: 500 },
    );
  }
}
