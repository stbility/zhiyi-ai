"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value?: string;
  onChange?: (value: string) => void;
  error?: boolean;
  /** 前置图标,渲染在输入框内左侧 */
  icon?: ReactNode;
  /** 无障碍标签。视觉上隐藏,但屏幕阅读器可读。 */
  label?: string;
  className?: string;
}

export function Input({
  value,
  onChange,
  error = false,
  disabled = false,
  icon,
  label,
  className,
  ...rest
}: InputProps) {
  const id = useId();

  return (
    <div
      className={cn(
        "bg-surface-2 rounded-control flex items-center gap-2 border px-3 py-2.5",
        "transition-colors duration-[var(--duration-hover)] ease-standard",
        // focus 状态由 :focus-within 驱动,不需要组件内 state
        error
          ? "border-error"
          : "border-border-default focus-within:border-border-focus",
        disabled && "opacity-50",
        className,
      )}
    >
      {icon}
      {label && (
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
      )}
      <input
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={error || undefined}
        onChange={(e) => onChange?.(e.target.value)}
        className="font-zh text-body text-fg placeholder:text-fg-tertiary min-w-0 flex-1 border-none bg-transparent outline-none"
        {...rest}
      />
    </div>
  );
}
