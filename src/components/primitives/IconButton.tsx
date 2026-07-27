import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  active?: boolean;
  /** 边长,单位 px。设计系统默认 36。 */
  size?: number;
  children?: ReactNode;
}

export function IconButton({
  active = false,
  size = 36,
  children,
  className,
  style,
  ...rest
}: IconButtonProps) {
  return (
    <button
      style={{ width: size, height: size, ...style }}
      className={cn(
        "rounded-control inline-flex cursor-pointer items-center justify-center border border-transparent",
        "transition-colors duration-[var(--duration-hover)] ease-standard",
        "focus-visible:outline-border-focus focus-visible:outline-2 focus-visible:outline-offset-2",
        active
          ? "bg-brand-tint text-brand"
          : "text-fg-secondary bg-transparent hover:bg-surface-3",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
