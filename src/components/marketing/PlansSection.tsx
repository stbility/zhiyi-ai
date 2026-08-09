"use client";

import { useState } from "react";

import { PricingCard } from "@/components/account/PricingCard";
import type { Plan } from "@/lib/plans";

/**
 * 定价网格(落地页 #pricing 与 /pricing 共用)。
 *
 * 付费套餐的月付/年付 CTA 都走 /api/billing/checkout(带 userId 归属),
 * 不再直连 Payment Link —— Payment Link 无法携带 userId,买了也解锁不了权益。
 * Free 档 CTA 是 /register 站内链接,不是支付按钮。
 *
 * 组件是唯一的渲染来源,页面只传数据(PLANS);样式全走设计系统 token。
 */

function startCheckout(
  planId: "professional" | "enterprise",
  interval: "month" | "year",
  setBusy: (v: boolean) => void,
  setError: (v: string | null) => void,
) {
  setBusy(true);
  setError(null);
  void (async () => {
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, interval }),
      });
      if (res.status === 401) {
        const next = encodeURIComponent(window.location.pathname);
        window.location.assign(`/login?next=${next}`);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
        hint?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `请求失败(HTTP ${res.status})`);
        return;
      }
      if (data.url) window.location.assign(data.url);
      else setError("服务未返回结账地址,请稍后重试。");
    } catch {
      setError("网络异常,请稍后重试。");
    } finally {
      setBusy(false);
    }
  })();
}

function PlanCard({ plan }: { plan: Plan }) {
  const isFree = plan.id === "free";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex w-65 flex-col">
      <PricingCard
        name={plan.name}
        price={plan.price ?? "价格待定"}
        period={plan.period ?? ""}
        features={plan.features}
        highlighted={plan.highlighted}
        annualNote={plan.annualNote}
        annualPrice={plan.annualPrice}
        ctaLabel={
          isFree ? "免费开始" : `立即订阅 ${plan.price ?? ""}${busy ? "…" : ""}`
        }
        href={isFree ? "/register" : undefined}
        onSelect={
          isFree
            ? undefined
            : (interval) => startCheckout(plan.id as "professional" | "enterprise", interval, setBusy, setError)
        }
      />
      {error && (
        <span className="text-error text-label mt-1.5 text-center">
          {error}
        </span>
      )}
    </div>
  );
}

export function PlansSection({ plans }: { plans: readonly Plan[] }) {
  return (
    <div className="flex flex-wrap justify-center gap-5">
      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} />
      ))}
    </div>
  );
}
