"use client";

import { useState } from "react";

import { Button, type ButtonVariant } from "@/components/primitives/Button";

/**
 * 订阅按钮。
 *
 * 主路径是 /api/billing/checkout —— 服务端拿登录态创建 Checkout Session,
 * 把 userId 写进 session.metadata 和 subscription_data.metadata。
 * webhook 据此把订阅精确落到这个账号上。这是唯一可靠的归属方式:
 * 静态 Payment Link 只能靠付款邮箱反查,付款邮箱和注册邮箱不一致就归不了户 ——
 * 钱收到了,权益发给了别人或者没发,而且事后无法自动纠正。
 *
 * 这个组件此前存在但**全仓库没有任何地方 import 它**,定价卡直接跳
 * Payment Link,于是安全路径整条是死的。现在由 PlansSection 渲染。
 *
 * 降级(不是「主路径」,是「主路径确实用不了时的最后一步」):
 * 后端 503 通常意味着 Price ID 没配 / Stripe 目录里找不到价格 ——
 * 这时挡住用户等于把能收的钱推走。有 fallbackUrl 就转 Payment Link,
 * 并如实告诉用户这条路要靠付款邮箱对账。没有 fallbackUrl 就照实报错,
 * 绝不假装跳转成功。
 *
 * 未登录(401)跳登录页,登录后回到当前页继续 —— 不在未登录状态下
 * 把人推去 Payment Link,那正是归属不了的那种付款。
 */

export interface SubscribeButtonProps {
  readonly planId: "professional" | "enterprise";
  /** 月付(默认)/年付 */
  readonly interval?: "month" | "year" | undefined;
  readonly label: string;
  readonly variant?: ButtonVariant | undefined;
  readonly size?: "sm" | "md" | "lg" | undefined;
  readonly className?: string | undefined;
  /** Checkout 不可用时的备用 Payment Link(已由调用方拼好 prefilled_email) */
  readonly fallbackUrl?: string | undefined;
}

export function SubscribeButton({
  planId,
  interval = "month",
  label,
  variant = "primary",
  size = "md",
  className,
  fallbackUrl,
}: SubscribeButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function subscribe() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 只传套餐标识与计费周期。金额、权益一概不从客户端来 ——
        // 价格由服务端按 planId 查 Stripe Price,权益由 webhook 按
        // Price 上的 metadata 判定。客户端说了不算。
        body: JSON.stringify({ planId, interval }),
      });

      // 未登录:后端返回 401「请先登录」—— 跳到登录页,回来接着买。
      // 这一步不降级到 Payment Link:未登录状态下付的款正是归不了户的那种。
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

      if (res.ok && data.url) {
        // Checkout Session 的 success_url 由服务端设为
        // /billing?session_id={CHECKOUT_SESSION_ID},付完自动回到订阅页。
        window.location.assign(data.url);
        return;
      }

      // 到这里说明服务端 Checkout 这条路当前走不通。
      if (fallbackUrl) {
        setNote(
          "正在改用备用支付链接。请使用与本站**同一个邮箱**付款,否则订阅无法自动归属到你的账号。",
        );
        window.location.assign(fallbackUrl);
        return;
      }

      setError(data.error ?? `请求失败(HTTP ${res.status})`);
    } catch {
      if (fallbackUrl) {
        setNote("网络异常,正在改用备用支付链接。");
        window.location.assign(fallbackUrl);
        return;
      }
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
      {note && (
        <span className="text-fg-tertiary text-label text-center">{note}</span>
      )}
      {error && (
        <span className="text-error text-label text-center">{error}</span>
      )}
    </span>
  );
}
