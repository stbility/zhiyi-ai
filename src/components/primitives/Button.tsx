import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  loading?: boolean | undefined;
  children?: ReactNode | undefined;
}

/**
 * hover / press 由 CSS 伪类实现,而非组件内 state。
 * 视觉与设计系统一致,但不会因指针移动触发重渲染。
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-on-brand border-brand hover:bg-brand-hover hover:border-brand-hover active:bg-brand-active active:border-brand-active",
  secondary:
    "bg-surface-3 text-fg border-border-default hover:bg-surface-4 active:bg-surface-4",
  ghost:
    "bg-transparent text-fg-secondary border-transparent hover:bg-surface-2 active:bg-surface-3",
  danger:
    "bg-error text-on-brand border-error hover:bg-error-hover hover:border-error-hover active:bg-error-active active:border-error-active",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "min-h-8 px-3.5 py-1.5 text-caption",
  md: "min-h-10 px-4 py-2.5",
  lg: "min-h-11 px-4.5 py-3",
};

/**
 * 按钮样式类。
 *
 * 导出以便 `next/link` 等非 button 元素复用同一套外观 —— 需要跳转的场景应该渲染
 * 真正的 <a>,而不是给 button 挂 onClick 做导航(那会丢失新标签页打开、
 * 右键菜单与爬虫可见性)。
 */
export function buttonClasses({
  variant = "primary",
  size = "md",
  disabled = false,
  className,
}: {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
} = {}): string {
  return cn(
    "font-zh text-button rounded-control inline-flex items-center justify-center gap-2 border font-medium whitespace-nowrap",
    "transition-colors duration-[var(--duration-hover)] ease-standard",
    "focus-visible:outline-border-focus focus-visible:outline-2 focus-visible:outline-offset-2",
    disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer",
    VARIANT[variant],
    SIZE[size],
    className,
  );
}

export function Button({
  variant = "primary",
  size = "md",
  disabled = false,
  loading = false,
  children,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      // 设计系统原行为:loading 时同样不可点击,但只有 disabled 才降低不透明度
      disabled={disabled || loading}
      className={buttonClasses({ variant, size, disabled, className })}
      {...rest}
    >
      {loading ? "···" : children}
    </button>
  );
}
