"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { UsageMeter } from "@/components/account/UsageMeter";
import { Button, StatusLabel } from "@/components/primitives";
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

/**
 * 订阅管理(仪表盘内)。只做「我现在的订阅」:套餐状态、本月用量、
 * 账单门户入口。套餐介绍与定价是落地页(产品页)的事,这里不重复。
 */
export function BillingManager({
  currentPlanId,
  subscription,
  stripeConfigured,
  stripeWebhookConfigured,
  usageUsed,
  usageQuota,
  activationPending = false,
}: {
  currentPlanId: string;
  subscription: SubscriptionRow | null;
  stripeConfigured: boolean;
  stripeWebhookConfigured: boolean;
  usageUsed: number;
  usageQuota: number | null;
  /** 付款已确认、订阅尚未落库(webhook 还在路上) */
  activationPending?: boolean | undefined;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  // 等 webhook 落库。
  //
  // 服务端已经向 Stripe 确认这笔钱付掉了,缺的只是订阅行 —— 通常一两秒就到。
  // 这里每 3 秒重取一次服务端数据,最多 20 次(1 分钟)后停手:
  // 无限轮询会把一个「webhook 没配对」的故障伪装成「还在处理中」,
  // 让用户一直等一个永远不会来的东西。到点就把话说清楚(见下方文案)。
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (!activationPending || subscription || waited >= 20) return;
    const t = setTimeout(() => {
      setWaited((n) => n + 1);
      router.refresh();
    }, 3000);
    return () => clearTimeout(t);
  }, [activationPending, subscription, waited, router]);

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
          Stripe 尚未配置(缺少 STRIPE_SECRET_KEY),订阅暂不可用。
          套餐与定价见落地页。
        </div>
      )}
      {stripeConfigured && !stripeWebhookConfigured && (
        <div className="border-warning bg-warning-tint text-warning rounded-control font-zh text-caption border border-dashed p-3">
          缺少 STRIPE_WEBHOOK_SECRET:可以发起订阅,但支付成功后状态不会自动落库,
          套餐权益不会变更。请配置 webhook 密钥后再开放订阅。
        </div>
      )}

      {error && (
        <p className="border-error-tint bg-error-tint text-error rounded-control font-zh text-caption p-3">
          {error}
        </p>
      )}

      {subscription ? (
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
      ) : activationPending ? (
        // 钱已经付了,订阅行还没到。绝不能在这一刻说「未订阅付费套餐」——
        // 那是整条闭环里最伤的一句话。
        <section className="bg-surface-2 border-brand rounded-card font-zh border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-fg text-body font-medium">支付已收到</h3>
            <StatusLabel tone="warning">正在开通</StatusLabel>
          </div>
          <p className="text-fg-secondary text-caption mt-2">
            {waited < 20
              ? "Stripe 已确认这笔付款,正在等待订阅信息同步(通常几秒)。本页会自动刷新。"
              : "付款已确认,但订阅信息超过一分钟仍未同步。你的钱没有问题,权益会在同步完成后自动生效;若长时间未恢复请联系我们并提供付款邮箱。"}
          </p>
        </section>
      ) : (
        <div className="border-border-default rounded-control font-zh border border-dashed p-4">
          <p className="text-fg-secondary text-caption">
            当前为免费套餐({currentPlanId === "free" ? "未订阅付费套餐" : currentPlanId})。
            套餐介绍与定价见落地页
            <Link href="/#pricing" className="text-brand hover:text-brand-hover mx-1">
              定价
            </Link>
            区块。
          </p>
        </div>
      )}

      {usageQuota !== null && usageQuota > 0 && (
        <section className="bg-surface-2 border-border-default rounded-card font-zh border p-4">
          <h3 className="text-fg text-body font-medium mb-2">本月用量</h3>
          <UsageMeter
            label="智能体步骤 (agent_turns)"
            used={usageUsed}
            total={usageQuota}
            unit=" 步"
          />
          <p className="text-fg-tertiary font-zh text-caption mt-1">
            按实际完成的智能体步骤计次:中断/失败只计已完成步骤,一步未完成不计费。
          </p>
        </section>
      )}
    </div>
  );
}
