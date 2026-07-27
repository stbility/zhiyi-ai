"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface CheckboxProps {
  checked?: boolean | undefined;
  onChange?: ((checked: boolean) => void) | undefined;
  label?: ReactNode | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}

/**
 * 用真实 input[type=checkbox] 承载状态与键盘交互,视觉方块覆盖其上。
 * 设计系统原实现是 span + onClick,不可聚焦、键盘不可达 —— 这里在不改变
 * 视觉的前提下修正为可访问实现。
 */
export function Checkbox({
  checked = false,
  onChange,
  label,
  disabled = false,
  className,
}: CheckboxProps) {
  return (
    <label
      className={cn(
        "font-zh text-body text-fg-secondary inline-flex items-center gap-2",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cn(
          "flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border",
          "transition-colors duration-[var(--duration-hover)] ease-standard",
          "peer-focus-visible:outline-border-focus peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2",
          checked
            ? "border-brand bg-brand"
            : "border-border-strong bg-transparent",
        )}
      >
        {checked && (
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="text-on-brand"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </span>
      {label}
    </label>
  );
}
