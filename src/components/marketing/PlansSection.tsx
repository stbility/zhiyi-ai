"use client";

import { useEffect, useState } from "react";

import { PricingCard } from "@/components/account/PricingCard";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Plan } from "@/lib/plans";

/**
 * 定价区(落地页/定价页共用)。
 *
 * 支付路径 = Stripe Payment Link(主):登录态下自动拼 `?prefilled_email=` ——
 * Stripe 收款时用该邮箱建 customer,webhook 按 customer.email 反查 app 用户,
 * 订阅落到正确账户。未登录则原样打开链接(webhook 的 email 兜底仍可归属)。
 * /api/billing/checkout 路由保留作后备(直接绑定 userId),此处不调用。
 */
function withPrefilledEmail(base: string | undefined, email: string | null): string | undefined {
  if (!base) return undefined;
  if (!email) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}prefilled_email=${encodeURIComponent(email)}`;
}

function PlanCard({ plan }: { plan: Plan }) {
  const isFree = plan.id === "free";
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;
    void supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
    });
  }, []);

  return (
    <div className="flex w-65 flex-col">
      <PricingCard
        name={plan.name}
        price={plan.price ?? "价格待定"}
        period={plan.period ?? ""}
        features={plan.features}
        highlighted={plan.highlighted}
        annualNote={plan.annualNote}
        annualHref={withPrefilledEmail(plan.annualStripeUrl, email)}
        ctaLabel={isFree ? "免费开始" : `立即订阅 ${plan.price ?? ""}`}
        href={isFree ? "/register" : withPrefilledEmail(plan.stripeUrl, email)}
        external={!isFree}
      />
    </div>
  );
}

export function PlansSection({ plans }: { plans: readonly Plan[] }) {
  return (
    <div className="flex flex-wrap items-stretch justify-center gap-4">
      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} />
      ))}
    </div>
  );
}
