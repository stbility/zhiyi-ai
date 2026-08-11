import { NextResponse } from "next/server";

import { getSiteUrl } from "@/lib/env/server";
import { getStripe } from "@/lib/billing/stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 账单门户(Customer Portal):改卡、改套餐、取消续订。
 *
 * 极薄的一层:取到 customer_id 就交给 Stripe 的门户会话。
 * 没有客户记录 = 从未订阅过,如实 404,不给假入口。
 */

export const dynamic = "force-dynamic";

export async function POST() {
  const stripe = getStripe();
  if (!stripe) {
    return NextResponse.json(
      {
        error: "Stripe 未配置。",
        hint: "缺少 STRIPE_SECRET_KEY,配置后账单门户才可用。",
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

  const { data } = await supabase
    .from("stripe_customers")
    .select("customer_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const customerId = data?.customer_id as string | undefined;
  if (!customerId) {
    return NextResponse.json(
      { error: "还没有订阅记录。先订阅一次,账单门户才会出现。" },
      { status: 404 },
    );
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${getSiteUrl()}/billing`,
    });
    return NextResponse.json({ url: session.url });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error && e.message.includes("No such customer")
            ? "Stripe 侧没有这个客户记录,请重新发起订阅。"
            : "打开账单门户失败,请稍后重试。",
      },
      { status: 502 },
    );
  }
}
