"use client";

import type { ReactNode } from "react";

import { Icon } from "@/components/icons/Icon";
import { Button } from "@/components/primitives/Button";
import { LinkButton } from "@/components/primitives/LinkButton";
import { cn } from "@/lib/cn";

export interface PricingCardProps {
  name: string;
  price: string;
  period: string;
  features?: readonly string[] | undefined;
  highlighted?: boolean | undefined;
  ctaLabel?: string | undefined;
  /**
   * 自定义 CTA(优先于 href / ctaLabel)。
   *
   * 付费档要走的是 SubscribeButton —— 它得先向 /api/billing/checkout
   * 换一个带 metadata.userId 的 Checkout Session,不是一个静态链接。
   * 卡片不认识订阅逻辑,只留一个位置给它。
   */
  cta?: ReactNode | undefined;
  /** 有 href 时 CTA 渲染为链接:外部地址(external=true)新开标签页,站内地址用 next/link */
  href?: string | undefined;
  /** href 为外部地址时置 true(渲染原生 <a> + target=_blank + noopener) */
  external?: boolean | undefined;
  /** 支付未接通时禁用并说明原因,不得渲染成点了没反应的按钮 */
  ctaDisabled?: boolean | undefined;
  ctaDisabledReason?: string | undefined;
  className?: string | undefined;
}

/**
 * 定价卡片。
 *
 * CTA 三种形态,按优先级:
 *   · cta —— 调用方给的动作组件(付费档走 SubscribeButton → 服务端
 *     Checkout Session,登录用户的订阅才能精确落到自己账上)
 *   · href —— 站内/外部链接(免费档指向 /register)
 *   · 都没有 —— 禁用态 Button,并说明原因
 *
 * 月付/年付切换由 PlansSection 顶部的原生 Button 分段控件统一管理
 * (Linear 官方滑动切换样式),卡片只负责按传入的金额/链接渲染。
 *
 * 唯一来源:卡片样式全部走设计系统 token,不拼接、不手抄类名。
 */
export function PricingCard({
  name,
  price,
  period,
  features = [],
  highlighted = false,
  ctaLabel = "升级套餐",
  cta,
  href,
  external,
  ctaDisabled = false,
  ctaDisabledReason,
  className,
}: PricingCardProps) {
  return (
    <div
      className={cn(
        "rounded-panel font-zh flex w-65 flex-col gap-3.5 border p-6",
        highlighted
          ? "bg-surface-3 border-brand"
          : "bg-surface-2 border-border-default",
        className,
      )}
    >
      <h3 className="text-fg text-[16px] font-semibold">{name}</h3>

      <p className="flex items-baseline gap-1">
        <span className="text-fg text-[32px] font-semibold">{price}</span>
        <span className="text-fg-tertiary text-caption">/{period}</span>
      </p>

      <ul className="flex flex-col gap-2">
        {features.map((feature) => (
          <li
            key={feature}
            className="text-fg-secondary flex items-center gap-2 text-[13px]"
          >
            <Icon name="check" size={14} className="text-success shrink-0" />
            {feature}
          </li>
        ))}
      </ul>

      {cta ? (
        <span className="mt-1.5 w-full">{cta}</span>
      ) : href ? (
        <LinkButton
          href={href}
          external={external}
          variant={highlighted ? "primary" : "secondary"}
          className="mt-1.5 w-full"
        >
          {ctaLabel}
        </LinkButton>
      ) : (
        <Button
          variant={highlighted ? "primary" : "secondary"}
          disabled={ctaDisabled}
          className="mt-1.5 w-full"
        >
          {ctaLabel}
        </Button>
      )}

      {ctaDisabled && ctaDisabledReason && (
        <p className="text-fg-tertiary text-label text-center">
          {ctaDisabledReason}
        </p>
      )}
    </div>
  );
}
