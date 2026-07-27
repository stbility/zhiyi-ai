import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface TagProps {
  children?: ReactNode | undefined;
  active?: boolean | undefined;
  onClick?: (() => void) | undefined;
  className?: string | undefined;
}

export function Tag({ children, active = false, onClick, className }: TagProps) {
  const interactive = typeof onClick === "function";

  const classes = cn(
    "font-zh text-caption inline-flex items-center rounded-full border px-3 py-[5px]",
    active
      ? "bg-brand-tint text-brand border-transparent"
      : "bg-surface-2 text-fg-secondary border-border-default",
    interactive ? "cursor-pointer" : "cursor-default",
    className,
  );

  // 可点击时渲染为 button,保证键盘可达;不可点击时保持为纯展示元素
  if (interactive) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {children}
      </button>
    );
  }

  return <span className={classes}>{children}</span>;
}
