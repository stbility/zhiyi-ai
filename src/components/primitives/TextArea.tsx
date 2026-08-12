"use client";

import { useId, type ReactNode, type TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

/**
 * 多行文本输入(设计系统原生组件,2026-08-12)。
 *
 * 与 Input.tsx 同一套视觉 token:bg-surface-2 + 边框 + rounded-control,
 * focus 由 :focus-within 驱动。此前对话输入框用裸 <textarea> + 手写
 * className,与系统其余输入(Input/Select)视觉不一致 —— 这里收口为
 * 原生组件,assistant 与 agent 两个页面天然统一。
 */
export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  error?: boolean | undefined;
  /** 前置图标,渲染在输入框内左侧 */
  icon?: ReactNode | undefined;
  /** 字段名称。默认显示在输入框上方。 */
  label?: string | undefined;
  /** 隐藏字段名称,只保留给屏幕阅读器 */
  hideLabel?: boolean | undefined;
  /** 字段说明,显示在输入框下方 */
  description?: string | undefined;
  /** 错误提示文字,显示在输入框下方 */
  errorMessage?: string | undefined;
  /**
   * 容器样式。
   * - "bordered"(默认):自带背景/边框/圆角,独立成框
   * - "flush":无背景无边框,融入外层容器 —— 一体式输入框用
   */
  variant?: "bordered" | "flush" | undefined;
  className?: string | undefined;
}

export function TextArea({
  value,
  onChange,
  error = false,
  disabled = false,
  icon,
  label,
  hideLabel = false,
  description,
  errorMessage,
  variant = "bordered",
  className,
  required,
  ...rest
}: TextAreaProps) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const hasError = error || errorMessage !== undefined;

  const field = (
    <div
      className={cn(
        variant === "bordered"
          ? "bg-surface-2 rounded-control flex items-start gap-2 border px-3 py-2.5"
          : "flex items-start gap-2",
        "transition-colors duration-[var(--duration-hover)] ease-standard",
        variant === "bordered" &&
          (hasError
            ? "border-error"
            : "border-border-default focus-within:border-border-focus"),
        disabled && "opacity-50",
        label ? undefined : className,
      )}
    >
      {icon}
      <textarea
        id={id}
        value={value}
        disabled={disabled}
        required={required}
        aria-invalid={hasError || undefined}
        aria-describedby={
          description || errorMessage ? descriptionId : undefined
        }
        onChange={(e) => onChange?.(e.target.value)}
        className="font-zh text-body text-fg placeholder:text-fg-tertiary min-w-0 flex-1 resize-none border-none bg-transparent outline-none"
        {...rest}
      />
    </div>
  );

  if (!label) return field;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={id}
        className={cn(
          "font-zh text-label text-fg-secondary",
          hideLabel && "sr-only",
        )}
      >
        {label}
        {required && (
          <span aria-hidden className="text-error ml-1">
            *
          </span>
        )}
      </label>

      {field}

      {(errorMessage ?? description) && (
        <p
          id={descriptionId}
          className={cn(
            "font-zh text-caption",
            hasError ? "text-error" : "text-fg-tertiary",
          )}
        >
          {errorMessage ?? description}
        </p>
      )}
    </div>
  );
}
