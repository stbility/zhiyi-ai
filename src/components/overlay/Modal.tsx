"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { Icon } from "@/components/icons/Icon";
import { cn } from "@/lib/cn";

export interface ModalProps {
  open: boolean;
  title: string;
  onClose?: (() => void) | undefined;
  children?: ReactNode | undefined;
  footer?: ReactNode | undefined;
  className?: string | undefined;
}

/**
 * 设计系统原实现只有一个 div + onClick 遮罩,没有 Escape 关闭、没有焦点管理、
 * 没有 aria 语义。移植时在不改变视觉的前提下补齐:role=dialog、aria-modal、
 * Escape 关闭、打开时焦点移入、关闭后焦点归还。
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  className,
}: ModalProps) {
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

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="bg-canvas/60 fixed inset-0 z-100 flex items-center justify-center p-4"
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
          "bg-surface-2 border-border-default rounded-modal shadow-modal font-zh w-110 max-w-full overflow-hidden border outline-none",
          className,
        )}
      >
        <div className="border-divider flex items-center justify-between gap-4 border-b px-5 py-[18px]">
          <h2 id={titleId} className="text-fg text-[16px] font-semibold">
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

        <div className="text-fg-secondary p-5 text-[14px] leading-[1.7]">
          {children}
        </div>

        {footer && (
          <div className="border-divider flex justify-end gap-2 border-t px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
