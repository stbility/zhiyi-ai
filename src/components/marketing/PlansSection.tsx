"use client";

import { useEffect, useState } from "react";

import { PricingCard } from "@/components/account/PricingCard";
import { SubscribeButton } from "@/components/marketing/SubscribeButton";
import { SegmentedControl } from "@/components/primitives/SegmentedControl";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Plan } from "@/lib/plans";

/**
 * 定价区(落地页/定价页共用)。
 *
 * 计费周期切换:Linear 官方月付/年付滑动切换样式 —— 原生 Button 分段控件,
 * 顶部全局切换(左右滑动即「月付 ↔ 年付」),所有卡片金额与 CTA 联动。
 *
 * 支付路径(2026-08-09 修正)= **服务端 Checkout Session**。
 * 付费档 CTA 走 SubscribeButton → /api/billing/checkout,服务端把
 * userId 写进 session metadata,webhook 据此把订阅精确落到该账号。
 *
 * 此前这里直接跳 Payment Link,只给链接拼一个 `?prefilled_email=` ——
 * 那是预填字段,不是身份:付款邮箱与注册邮箱不一致就归不了户,
 * 钱收到了而权益没发到正确账号,事后也无法自动纠正。
 * Payment Link 现在退为**备用**:只有服务端 Checkout 确实不可用
 * (Price ID 未配置等)时才降级过去,并当场告诉用户要用同一个邮箱付款。
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

  const shownPrice =
    isFree || !isYear ? plan.price : (plan.annualPrice?.split("/")[0] ?? plan.price);
  const shownPeriod = isFree || !isYear ? plan.period : "年";
  const ctaLabel = isFree
    ? "免费开始"
    : plan.id === "enterprise"
      ? "联系销售"
      : "立即订阅";

  // 免费档没有订阅动作,CTA 就是注册链接。
  // 付费档(非 enterprise):走服务端 Checkout。Payment Link 只作为 checkout 不可用时的备用。
  if (isFree || plan.id === "enterprise") {
    const enterpriseHref = isFree
      ? "/register"
      : withPrefilledEmail(
          isYear ? plan.paymentLinkYear : plan.paymentLinkMonth,
          email,
        );
    return (
      <PricingCard
        name={plan.name}
        price={shownPrice ?? ""}
        period={shownPeriod ?? ""}
        features={plan.features}
        highlighted={plan.highlighted}
        ctaLabel={ctaLabel}
        href={enterpriseHref}
      />
    );
  }

  // 付费档(专业版/进阶版/团队版):走服务端 Checkout。
  const fallbackUrl = withPrefilledEmail(
    isYear ? plan.paymentLinkYear : plan.paymentLinkMonth,
    email,
  );

  // Plan id is narrowed by the above conditionals: free|enterprise handled, rest fall through.
  const paidPlanId = plan.id as "professional" | "professional_plus" | "team";

  return (
    <PricingCard
      name={plan.name}
      price={shownPrice ?? "价格待定"}
      period={shownPeriod ?? ""}
      features={plan.features}
      highlighted={plan.highlighted}
      cta={
        <SubscribeButton
          planId={paidPlanId}
          interval={interval}
          label={ctaLabel}
          variant={plan.highlighted ? "primary" : "secondary"}
          className="w-full"
          fallbackUrl={fallbackUrl}
        />
      }
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
