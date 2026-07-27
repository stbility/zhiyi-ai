"use client";

import type { SelectHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> {
  value?: string;
  options?: readonly SelectOption[];
  onChange?: (value: string) => void;
  className?: string;
}

export function Select({
  value,
  options = [],
  onChange,
  className,
  ...rest
}: SelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      className={cn(
        "bg-surface-2 text-fg font-zh text-body rounded-control border-border-default border px-3 py-2.5 outline-none",
        "transition-colors duration-[var(--duration-hover)] ease-standard",
        "focus:border-border-focus",
        className,
      )}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
