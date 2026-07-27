"use client";

import { Icon } from "@/components/icons/Icon";
import { cn } from "@/lib/cn";

export interface TopCommandBarProps {
  title: string;
  onSearch?: (() => void) | undefined;
  className?: string | undefined;
}

export function TopCommandBar({
  title,
  onSearch,
  className,
}: TopCommandBarProps) {
  return (
    <header
      className={cn(
        "bg-canvas border-border-default font-zh flex h-14 shrink-0 items-center justify-between gap-4 border-b px-6",
        className,
      )}
    >
      <h1 className="text-fg text-body truncate font-medium">{title}</h1>

      <button
        type="button"
        onClick={onSearch}
        className="bg-surface-2 border-border-default rounded-control text-fg-tertiary hover:border-border-strong flex min-w-65 cursor-pointer items-center gap-2 border px-3 py-[7px] text-[13px] transition-colors duration-[var(--duration-hover)] ease-standard"
      >
        <Icon name="search" size={15} className="shrink-0" />
        <span className="flex-1 text-left">搜索文件、工作流或记忆…</span>
        <span className="border-border-default rounded-tag shrink-0 border px-[5px] py-px font-mono text-[11px]">
          ⌘K
        </span>
      </button>
    </header>
  );
}
