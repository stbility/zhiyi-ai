"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { Icon } from "@/components/icons/Icon";
import { cn } from "@/lib/cn";

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose?: (() => void) | undefined;
  children?: ReactNode | undefined;
  side?: "left" | "right" | undefined;
  className?: string | undefined;
}

export function Drawer({
  open,
  title,
  onClose,
  children,
  side = "right",
  className,
}: DrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={cn(
        "bg-canvas/50 fixed inset-0 z-100 flex",
        side === "right" ? "justify-end" : "justify-start",
      )}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "bg-surface-1 shadow-flyout font-zh flex h-full w-85 max-w-[90vw] flex-col outline-none",
          className,
        )}
      >
        <div className="border-divider flex items-center justify-between gap-4 border-b px-[18px] py-4">
          <h2 id={titleId} className="text-fg text-body font-medium">
            {title}
          </h2>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="text-fg-tertiary hover:text-fg-secondary cursor-pointer transition-colors duration-[var(--duration-hover)] ease-standard"
            >
              <Icon name="x" size={16} />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-[18px]">{children}</div>
      </div>
    </div>
  );
}
