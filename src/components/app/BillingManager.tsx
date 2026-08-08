"use client";

import { useState } from "react";

import { PricingCard } from "@/components/account/PricingCard";
import { UsageMeter } from "@/components/account/UsageMeter";
import { Button, StatusLabel } from "@/components/primitives";
import type { Plan } from "@/lib/plans";
import type { SubscriptionRow } from "@/app/(app)/billing/page";

const STATUS_LABEL: Record<string, string> = {
  active: "生效中",
  trialing: "试用中",
  past_due: "逾期未付",
  canceled: "已取消",
  unpaid: "未支付",
  incomplete: "未完成",
  paused: "已暂停",
  incomplete_expired: "已过期",
};

function formatPeriodEnd(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return iso;
  }
}

async function postJson(url: string, body: unknown): Promise<{ url?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    url?: string;
    error?: string;
    hint?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? `请求失败(HTTP ${res.status})`);
  }
  return data;
}

export function BillingManager({
  plans,
  currentPlanId,
  subscription,
  stripeConfigured,
  stripeWebhookConfigured,
  usageUsed,
  usageQuota,
}: {
  plans: readonly Plan[];
  currentPlanId: string;
  subscription: SubscriptionRow | null;
  stripeConfigured: boolean;
  stripeWebhookConfigured: boolean;
  usageUsed: number;
  usageQuota: number | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function subscribe(planId: string) {
    setBusy(`checkout-${planId}`);
    setError(null);
    try {
      const { url } = await postJson("/api/billing/checkout", { planId });
      if (url) window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy("portal");
    setError(null);
    try {
      const { url } = await postJson("/api/billing/portal", {});
      if (url) window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!stripeConfigured && (
        <div className="border-warning bg-warning-tint text-warning rounded-control font-zh text-caption border border-dashed p-3">
          Stripe 尚未配置(缺少 STRIPE_SECRET_KEY),订阅暂不可用。配置后刷新本页即可。
        </div>
      )}
      {stripeConfigured && !stripeWebhookConfigured && (
        <div className="border-warning bg-warning-tint text-warning rounded-control font-zh text-caption border border-dashed p-3">
          缺少 STRIPE_WEBHOOK_SECRET:可以发起订阅,但支付成功后状态不会自动落库,
          套餐权益不会变更。请配置 webhook 密钥后再开放订阅。
        </div>
      )}

      {subscription && (
        <section className="bg-surface-2 border-border-default rounded-card font-zh border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-fg text-body font-medium">当前订阅</h3>
            <StatusLabel tone="success">
              {`${subscription.planId} · ${STATUS_LABEL[subscription.status] ?? subscription.status}`}
            </StatusLabel>
            {subscription.cancelAtPeriodEnd && (
              <StatusLabel tone="warning">本期结束后取消</StatusLabel>
            )}
          </div>
          <p className="text-fg-secondary text-caption mt-2">
            当前周期至 {formatPeriodEnd(subscription.currentPeriodEnd)}
          </p>
          <div className="mt-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => void openPortal()}
            >
              {busy === "portal" ? "跳转中…" : "管理账单(改卡 / 改套餐 / 取消)"}
            </Button>
          </div>
        </section>
      )}

      {error && (
        <p className="border-error-tint bg-error-tint text-error rounded-control font-zh text-caption p-3">
          {error}
        </p>
      )}

      {usageQuota !== null && usageQuota > 0 && (
        <section className="bg-surface-2 border-border-default rounded-card font-zh border p-4">
          <h3 className="text-fg text-body font-medium mb-2">本月用量</h3>
          <UsageMeter
            label="智能体轮次 (agent_turns)"
            used={usageUsed}
            total={usageQuota}
            unit=" 轮"
          />
        </section>
      )}

      <div className="flex flex-wrap gap-4">
        {plans.map((plan) => {
          const isCurrent = plan.id === currentPlanId;
          const isPaid = plan.id !== "free";
          const priceReady = plan.price !== undefined;

          return (
            <PricingCard
              key={plan.id}
              name={plan.name}
              price={priceReady ? (plan.price as string) : "价格待配置"}
              period={plan.period}
              features={plan.features}
              highlighted={plan.highlighted}
              ctaLabel={
                isCurrent
                  ? "当前套餐"
                  : isPaid
                    ? priceReady
                      ? `升级到 ${plan.name}`
                      : "价格待配置"
                    : "免费套餐"
              }
              onSelect={isCurrent ? undefined : () => void subscribe(plan.id)}
              ctaDisabled={
                isCurrent ||
                !isPaid ||
                busy !== null ||
                !priceReady ||
                !stripeWebhookConfigured
              }
              ctaDisabledReason={
                isCurrent
                  ? undefined
                  : !priceReady
                    ? "Stripe 价格未配置"
                    : !stripeWebhookConfigured
                      ? "等待 webhook 密钥配置"
                      : undefined
              }
            />
          );
        })}
      </div>
    </div>
  );
}
