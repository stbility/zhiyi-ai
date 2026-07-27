"use client";

import { cn } from "@/lib/cn";

export interface TabItem {
  value: string;
  label: string;
}

export interface TabsProps {
  items?: readonly TabItem[];
  value?: string;
  onChange?: (value: string) => void;
  className?: string;
}

export function Tabs({ items = [], value, onChange, className }: TabsProps) {
  return (
    <div
      role="tablist"
      className={cn("border-border-default flex gap-1 border-b", className)}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange?.(item.value)}
            className={cn(
              "font-zh text-body mr-5 cursor-pointer border-b-2 bg-transparent px-1 py-2.5",
              "transition-colors duration-[var(--duration-hover)] ease-standard",
              "focus-visible:outline-border-focus focus-visible:outline-2 focus-visible:outline-offset-2",
              active
                ? "text-fg border-brand"
                : "text-fg-tertiary border-transparent",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
