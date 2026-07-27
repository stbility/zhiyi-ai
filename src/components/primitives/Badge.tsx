import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type BadgeTone =
  | "neutral"
  | "brand"
  | "success"
  | "warning"
  | "error"
  | "info";

export interface BadgeProps {
  tone?: BadgeTone;
  children?: ReactNode;
  className?: string;
}

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-surface-3 text-fg-secondary border-border-default",
  brand: "bg-brand-tint text-brand border-transparent",
  success: "bg-success-tint text-success border-transparent",
  warning: "bg-warning-tint text-warning border-transparent",
  error: "bg-error-tint text-error border-transparent",
  info: "bg-info-tint text-info border-transparent",
};

export function Badge({ tone = "neutral", children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "font-zh text-label rounded-tag inline-flex items-center gap-1.5 border px-2 py-[3px] font-medium whitespace-nowrap",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
