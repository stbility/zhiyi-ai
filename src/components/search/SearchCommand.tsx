"use client";

import { useEffect, useRef } from "react";

import { Icon, type IconName } from "@/components/icons/Icon";

export interface SearchResult {
  id: string;
  title: string;
  category: string;
  icon?: IconName | undefined;
}

export interface SearchCommandProps {
  open: boolean;
  onClose?: (() => void) | undefined;
  query?: string | undefined;
  onQueryChange?: ((value: string) => void) | undefined;
  results?: readonly SearchResult[] | undefined;
  onSelect?: ((result: SearchResult) => void) | undefined;
  /** 空结果文案。检索服务不可用时应由调用方传入如实说明,而非沿用「没有找到」。 */
  emptyLabel?: string | undefined;
}

export function SearchCommand({
  open,
  onClose,
  query = "",
  onQueryChange,
  results = [],
  onSelect,
  emptyLabel = "没有找到匹配结果",
}: SearchCommandProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;

    inputRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="bg-canvas/60 fixed inset-0 z-100 flex items-start justify-center px-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal
        aria-label="全局搜索"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface-2 border-border-default rounded-panel shadow-dropdown font-zh w-140 max-w-full overflow-hidden border"
      >
        <div className="border-divider flex items-center gap-2.5 border-b px-[18px] py-3.5">
          <Icon name="search" size={16} className="text-fg-tertiary shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange?.(e.target.value)}
            placeholder="搜索文件、工作流或记忆…"
            aria-label="搜索"
            className="text-fg font-zh text-body placeholder:text-fg-tertiary min-w-0 flex-1 border-none bg-transparent outline-none"
          />
          <span className="text-fg-tertiary border-border-default rounded-tag shrink-0 border px-[5px] py-px font-mono text-[11px]">
            ESC
          </span>
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5">
          {results.map((result) => (
            <button
              key={result.id}
              type="button"
              onClick={() => onSelect?.(result)}
              className="rounded-control hover:bg-surface-3 flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.25 text-left transition-colors duration-[var(--duration-hover)] ease-standard"
            >
              <Icon
                name={result.icon ?? "knowledge"}
                size={15}
                className="text-fg-tertiary shrink-0"
              />
              <span className="text-fg flex-1 truncate text-[14px]">
                {result.title}
              </span>
              <span className="text-fg-tertiary text-label shrink-0">
                {result.category}
              </span>
            </button>
          ))}

          {results.length === 0 && (
            <p className="text-fg-tertiary text-caption px-3 py-6 text-center">
              {emptyLabel}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
