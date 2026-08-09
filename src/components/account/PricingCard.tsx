"use client";

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
 * CTA 两种形态:
 *   · 有 href —— Payment Link(主支付路径),渲染为 LinkButton external,
 *     新开标签页并带 noopener;登录态由调用方拼 prefilled_email 绑定用户
 *   · 无 href —— 站内动作(如打开升级抽屉),渲染为 Button
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

      {href ? (
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
