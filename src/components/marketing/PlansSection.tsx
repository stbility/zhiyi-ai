"use client";

import { useEffect, useState } from "react";

import { PricingCard } from "@/components/account/PricingCard";
import { SegmentedControl } from "@/components/primitives/SegmentedControl";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Plan } from "@/lib/plans";

/**
 * 定价区(落地页/定价页共用)。
 *
 * 计费周期切换:Linear 官方月付/年付滑动切换样式 —— 原生 Button 分段控件,
 * 顶部全局切换(左右滑动即「月付 ↔ 年付」),所有卡片金额与 CTA 联动。
 *
 * 支付路径 = Stripe Payment Link:登录态下自动拼 `?prefilled_email=` ——
 * Stripe 收款时用该邮箱建 customer,webhook 按 customer.email 反查 app 用户,
 * 订阅落到正确账户。未登录则原样打开链接(webhook 的 email 兜底仍可归属)。
 * /api/billing/checkout 路由保留作后备(直接绑定 userId)。
 */
function withPrefilledEmail(
  base: string | undefined,
  email: string | null,
): string | undefined {
  if (!base) return undefined;
  if (!email) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}prefilled_email=${encodeURIComponent(email)}`;
}

function PlanCard({
  plan,
  interval,
  email,
}: {
  plan: Plan;
  interval: "month" | "year";
  email: string | null;
}) {
  const isFree = plan.id === "free";
  const isYear = interval === "year";

  const link = isFree
    ? "/register"
    : withPrefilledEmail(isYear ? plan.annualStripeUrl : plan.stripeUrl, email);
  const shownPrice =
    isFree || !isYear ? plan.price : (plan.annualPrice?.split("/")[0] ?? plan.price);
  const shownPeriod = isFree || !isYear ? plan.period : "年";

  return (
    <PricingCard
      name={plan.name}
      price={shownPrice ?? "价格待定"}
      period={shownPeriod ?? ""}
      features={plan.features}
      highlighted={plan.highlighted}
      ctaLabel={
        isFree
          ? "免费开始"
          : `立即订阅 ${shownPrice ?? ""}${isYear ? "/年" : `/${plan.period ?? ""}`}`
      }
      href={link}
      external={!isFree}
    />
  );
}

export function PlansSection({ plans }: { plans: readonly Plan[] }) {
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;
    void supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
    });
  }, []);

  return (
    <div className="flex flex-col items-center gap-6">
      {/* Linear 官方月付/年付滑动切换:设计系统原生 SegmentedControl。
          年付一侧直接标注「省 2 个月」,一眼看到优惠。 */}
      <SegmentedControl<"month" | "year">
        ariaLabel="计费周期"
        options={[
          { value: "month", label: "月付" },
          { value: "year", label: "年付 · 省 2 个月" },
        ]}
        value={interval}
        onChange={setInterval}
      />

      <div className="flex flex-wrap items-stretch justify-center gap-4">
        {plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            interval={interval}
            email={email}
          />
        ))}
      </div>
    </div>
  );
}
