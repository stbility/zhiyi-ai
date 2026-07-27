"use client";

import { cn } from "@/lib/cn";

export interface SwitchProps {
  checked?: boolean | undefined;
  onChange?: ((checked: boolean) => void) | undefined;
  disabled?: boolean | undefined;
  /** 无障碍标签 */
  label?: string | undefined;
  className?: string | undefined;
}

/**
 * 用 role=switch 的 button 实现,键盘可达。
 * 设计系统原实现是 span + onClick,屏幕阅读器无法识别其为开关。
 */
export function Switch({
  checked = false,
  onChange,
  disabled = false,
  label,
  className,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cn(
        "inline-flex h-[22px] w-10 items-center rounded-full p-0.5",
        "transition-colors duration-[var(--duration-hover)] ease-standard",
        "focus-visible:outline-border-focus focus-visible:outline-2 focus-visible:outline-offset-2",
        checked ? "bg-brand" : "bg-surface-4",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "bg-on-brand size-[18px] rounded-full",
          "transition-transform duration-[var(--duration-hover)] ease-standard",
          checked ? "translate-x-[18px]" : "translate-x-0",
        )}
      />
    </button>
  );
}
