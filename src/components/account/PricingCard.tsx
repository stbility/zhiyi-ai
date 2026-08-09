"use client";

import { useState } from "react";

import { Badge } from "@/components/primitives/Badge";
import { Button } from "@/components/primitives/Button";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Icon } from "@/components/icons/Icon";
import { LinkButton } from "@/components/primitives/LinkButton";
import { cn } from "@/lib/cn";

export interface PricingCardProps {
  name: string;
  price: string;
  period: string;
  features?: readonly string[] | undefined;
  highlighted?: boolean | undefined;
  /** 年付优惠说明(如「年付 HK490,约省 2 个月」);undefined 时按年勾选不可用 */
  annualNote?: string | undefined;
  /** 年付金额文案(如「HK490/年」);勾选按年付费时金额区切换显示 */
  annualPrice?: string | undefined;
  ctaLabel?: string | undefined;
  /** 有 href 时 CTA 渲染为链接:外部地址(external=true)新开标签页,站内地址用 next/link */
  href?: string | undefined;
  /** href 为外部地址时置 true(渲染原生 <a> + target=_blank + noopener) */
  external?: boolean | undefined;
  /**
   * 站内动作(如打开升级抽屉/发起 checkout)。
   * 签名带 billing interval:Linear 模式 = 每卡「按年付费」勾选,CTA 按勾选态
   * 传 month/year,不再有独立的年付按钮。
   */
  onSelect?: ((interval: "month" | "year") => void) | undefined;
  /** 支付未接通时禁用并说明原因,不得渲染成点了没反应的按钮 */
  ctaDisabled?: boolean | undefined;
  ctaDisabledReason?: string | undefined;
  className?: string | undefined;
}

/**
 * 定价卡片 —— 对齐 Linear 定价页(https://linear.app/pricing):
 *   · 每卡一个「按年付费」勾选(原生 Checkbox),金额随勾选切换
 *   · 勾选后「省 2 个月」以原生 Badge 呈现(金额下方)
 *   · 单 CTA 按钮,按勾选态发起 month/year 购买,不再有第二个年付按钮
 *
 * CTA 两种形态:
 *   · 有 href —— 外部支付链接(Stripe Payment Link),渲染为 LinkButton external,
 *     新开标签页并带 noopener
 *   · 无 href —— 站内动作(如打开升级抽屉),渲染为 Button
 *
 * 唯一来源:卡片样式全部走设计系统 token,不拼接、不手抄类名。
 */
export function PricingCard({
  name,
  price,
  period,
  features = [],
  highlighted = false,
  annualNote,
  annualPrice,
  ctaLabel = "升级套餐",
  href,
  external,
  onSelect,
  ctaDisabled = false,
  ctaDisabledReason,
  className,
}: PricingCardProps) {
  const [yearly, setYearly] = useState(false);
  const canYearly = Boolean(annualNote) && !href;

  // 按年勾选后金额区切换:HK49/月 → HK490/年(拆成大字金额 + /年 后缀)
  const shownPrice =
    yearly && annualPrice ? annualPrice.split("/")[0] ?? annualPrice : price;
  const shownPeriod =
    yearly && annualPrice
      ? `/${annualPrice.split("/")[1] ?? "年"}`
      : `/${period}`;

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
        <span className="text-fg text-[32px] font-semibold">{shownPrice}</span>
        <span className="text-fg-tertiary text-caption">{shownPeriod}</span>
      </p>

      {/* Linear 模式:每卡「按年付费」勾选;勾选后金额下方以 Badge 呈现省多少。
          年付未开通(无 annualNote)或走外部链接时不渲染 —— 不给假的勾选。 */}
      {canYearly && (
        <div className="flex flex-col items-start gap-1.5">
          <Checkbox
            checked={yearly}
            onChange={setYearly}
            label="按年付费"
          />
          {yearly && annualNote && (
            <Badge tone="brand">{annualNote}</Badge>
          )}
        </div>
      )}

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
          onClick={() => onSelect?.(yearly ? "year" : "month")}
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
