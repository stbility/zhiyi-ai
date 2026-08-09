"use client";

import { useState } from "react";

import { Button, type ButtonVariant } from "@/components/primitives/Button";

/**
 * 订阅按钮(月付/年付)。
 *
 * 走 /api/billing/checkout 创建 Stripe Checkout Session —— 这是正式订阅路径:
 * 登录态下服务端写入 metadata.userId,webhook 才能把订阅归属到 app 用户,
 * 权益(0034)才会真正解锁。曾有的 Payment Link(plans.ts 里的 stripeUrl)
 * 已移除 —— 静态链接无法携带 userId,付款后定位不到用户,不能作为正式入口。
 *
 * 诚实降级:未配置 Stripe/价格时后端返回 503,这里如实显示错误文案,
 * 绝不假装跳转成功。未登录(401)跳登录页,登录后回到当前页继续。
 */

export interface SubscribeButtonProps {
  readonly planId: "professional" | "enterprise";
  /** 月付(默认)/年付 */
  readonly interval?: "month" | "year" | undefined;
  readonly label: string;
  readonly variant?: ButtonVariant | undefined;
  readonly size?: "sm" | "md" | "lg" | undefined;
  readonly className?: string | undefined;
}

export function SubscribeButton({
  planId,
  interval = "month",
  label,
  variant = "primary",
  size = "md",
  className,
}: SubscribeButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function subscribe() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, interval }),
      });

      // 未登录:后端返回 401「请先登录」—— 跳到登录页,回来接着买。
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
      if (data.url) {
        window.location.assign(data.url);
      } else {
        setError("服务未返回结账地址,请稍后重试。");
      }
    } catch {
      setError("网络异常,请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex w-full flex-col gap-1.5">
      <Button
        variant={variant}
        size={size}
        disabled={busy}
        onClick={() => void subscribe()}
        className={className}
      >
        {busy ? "跳转中…" : label}
      </Button>
      {error && (
        <span className="text-error text-label text-center">{error}</span>
      )}
    </span>
  );
}
