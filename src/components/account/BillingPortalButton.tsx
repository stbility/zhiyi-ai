"use client";

import { useState } from "react";

import { Button } from "@/components/primitives/Button";

export interface BillingPortalButtonProps {
  /** 未提供 upgradePriceId 时打开账单门户(管理现有订阅);提供时走 checkout(升级) */
  upgradePriceId?: string | undefined;
  label?: string | undefined;
  disabled?: boolean | undefined;
}

/**
 * 账单门户 / 升级按钮。
 *
 * 点击后调用对应 API,拿到 Stripe 托管的 URL 后跳转。
 * 错误如实展示 —— 支付通道未接通时按钮是 disabled 的(由父级决定),
 * 不会渲染成点了没反应的假按钮。
 */
export function BillingPortalButton({
  upgradePriceId,
  label,
  disabled = false,
}: BillingPortalButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const endpoint = upgradePriceId ? "/api/stripe/checkout" : "/api/stripe/portal";

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // exactOptionalPropertyTypes:不传 undefined body,分支构造
        ...(upgradePriceId
          ? { body: JSON.stringify({ priceId: upgradePriceId }) }
          : {}),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "操作失败,请稍后再试。");
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("网络错误,请稍后再试。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        onClick={handleClick}
        disabled={disabled || loading}
        variant={upgradePriceId ? "primary" : "secondary"}
      >
        {loading ? "处理中…" : (label ?? "管理订阅")}
      </Button>
      {error && <p className="text-warning text-label">{error}</p>}
    </div>
  );
}
