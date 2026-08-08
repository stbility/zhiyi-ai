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
  /** 有 href 时 CTA 渲染为外部链接(Stripe Payment Link 等);无 href 时渲染为按钮 */
  href?: string | undefined;
  onSelect?: (() => void) | undefined;
  /** 支付未接通时禁用并说明原因,不得渲染成点了没反应的按钮 */
  ctaDisabled?: boolean | undefined;
  ctaDisabledReason?: string | undefined;
  className?: string | undefined;
}

/**
 * 定价卡片。
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
  ctaLabel = "升级套餐",
  href,
  onSelect,
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
          external
          variant={highlighted ? "primary" : "secondary"}
          className="mt-1.5 w-full"
        >
          {ctaLabel}
        </LinkButton>
      ) : (
        <Button
          variant={highlighted ? "primary" : "secondary"}
          onClick={onSelect}
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
