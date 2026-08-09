import type { Metadata } from "next";
import Link from "next/link";

import { BillingManager } from "@/components/app/BillingManager";
import { getMyEntitlements } from "@/lib/billing/entitlements";
import { getStripeConfig } from "@/lib/billing/stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "订阅管理 · 智一 AI" };
export const dynamic = "force-dynamic";

export interface SubscriptionRow {
  readonly planId: string;
  readonly status: string;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
}

async function loadSubscription(): Promise<SubscriptionRow | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // RLS(0033):用户只能读自己的订阅。
  const { data } = await supabase
    .from("subscriptions")
    .select(
      "plan_id, status, current_period_end, cancel_at_period_end",
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return {
    planId: data.plan_id as string,
    status: data.status as string,
    currentPeriodEnd: (data.current_period_end as string | null) ?? null,
    cancelAtPeriodEnd: (data.cancel_at_period_end as boolean) ?? false,
  };
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  // 权益判定走数据库(0034 get_entitlements),不信任任何客户端字段。
  const entitlements = await getMyEntitlements();
  const subscription = await loadSubscription();
  const stripeConfig = getStripeConfig();

  // 付款回跳:Stripe 把浏览器送回来通常快过它把 webhook 送到我们这里。
  // 订阅还没落库时,页面不能对刚付完钱的人说「当前为免费套餐」。
  // 只影响文案 —— 不写库、不解锁,权益仍只来自 get_entitlements。
  let activationPending = false;
  if (!subscription) {
    const sessionId = (await searchParams).session_id;
    if (sessionId) {
      const supa = await createSupabaseServerClient();
      const uid = supa ? (await supa.auth.getUser()).data.user?.id : undefined;
      if (uid) {
        const { isActivationPending } = await import(
          "@/lib/billing/checkout-session"
        );
        activationPending = await isActivationPending(sessionId, uid);
      }
    }
  }

  // 本月用量(get_monthly_usage 0035,security definer 只返回调用者自己的)。
  // 拿不到就不展示用量条 —— 如实降级,不显示假数字。
  let usageUsed = 0;
  let usageQuota: number | null = null;
  const supabase = await createSupabaseServerClient();
  if (supabase && entitlements) {
    usageQuota = entitlements.byFeature.get("monthly_agent_turns") ?? null;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data } = await supabase.rpc("get_monthly_usage", {
        p_user_id: user.id,
      });
      if (Array.isArray(data)) {
        usageUsed = (data as { category: string; units: number }[]).reduce(
          (sum, row) =>
            row.category === "agent_turns" ? sum + (row.units ?? 0) : sum,
          0,
        );
      }
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-8 md:py-10">
      <header>
        <h2 className="text-fg text-h2 font-zh font-semibold">订阅管理</h2>
        <p className="text-fg-secondary font-zh text-caption mt-2">
          当前套餐、本月用量与账单管理。套餐介绍与定价见
          <Link href="/#pricing" className="text-brand hover:text-brand-hover mx-1">
            落地页定价
          </Link>
          。
        </p>
      </header>

      <BillingManager
        currentPlanId={entitlements?.planId ?? "free"}
        subscription={subscription}
        stripeConfigured={stripeConfig !== null}
        stripeWebhookConfigured={Boolean(stripeConfig?.webhookSecret)}
        usageUsed={usageUsed}
        usageQuota={usageQuota}
        activationPending={activationPending}
      />
    </div>
  );
}
