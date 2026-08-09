"use client";

import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 无障碍标签,如「计费周期」 */
  ariaLabel?: string | undefined;
  className?: string | undefined;
}

/**
 * 分段滑动切换控件(设计系统原生组件)。
 *
 * 场景:月付 | 年付 · 省 2 个月(Linear 官方定价页同款 —— 左右滑动切换,
 * 激活段凸起即「滑过去」的视觉)。
 *
 * 样式全部走设计系统 token(CSS 变量):容器 bg-surface-2 + border,
 * 激活段 bg-surface-3(浮起一层,浅色主题下自动反转),文字 text-fg 层级。
 * 深浅主题由 :root[data-theme] 覆盖变量自动适配,组件零硬编码色值。
 *
 * 实现照 Tabs 的惯例:原生 <button> + token 类,不套 Button(避免嵌套按钮
 * 语义),键盘/焦点可见(aria-pressed + focus-visible outline)。
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "border-border-default bg-surface-2 rounded-control inline-flex items-center gap-0.5 border p-1",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "font-zh text-button rounded-control inline-flex min-h-8 cursor-pointer items-center px-3.5 py-1.5",
              "transition-colors duration-[var(--duration-hover)] ease-standard",
              "focus-visible:outline-border-focus focus-visible:outline-2 focus-visible:outline-offset-2",
              active
                ? "bg-surface-3 text-fg"
                : "text-fg-tertiary hover:bg-surface-2",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
