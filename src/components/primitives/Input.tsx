"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  error?: boolean | undefined;
  /** 前置图标,渲染在输入框内左侧 */
  icon?: ReactNode | undefined;
  /** 字段名称。默认显示在输入框上方。 */
  label?: string | undefined;
  /**
   * 隐藏字段名称,只保留给屏幕阅读器。
   *
   * 仅用于「字段用途一望而知」的场景,例如顶部搜索框。
   * 一般表单不要开启:占位提示会在用户开始输入后消失,
   * 若没有可见标签,用户填到一半就不知道这一栏是什么了。
   */
  hideLabel?: boolean | undefined;
  /** 字段说明,显示在输入框下方 */
  description?: string | undefined;
  /** 错误提示文字,显示在输入框下方 */
  errorMessage?: string | undefined;
  className?: string | undefined;
}

export function Input({
  value,
  onChange,
  error = false,
  disabled = false,
  icon,
  label,
  hideLabel = false,
  description,
  errorMessage,
  className,
  required,
  ...rest
}: InputProps) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const hasError = error || errorMessage !== undefined;

  const field = (
    <div
      className={cn(
        "bg-surface-2 rounded-control flex items-center gap-2 border px-3 py-2.5",
        "transition-colors duration-[var(--duration-hover)] ease-standard",
        // focus 状态由 :focus-within 驱动,不需要组件内 state
        hasError
          ? "border-error"
          : "border-border-default focus-within:border-border-focus",
        disabled && "opacity-50",
        // 无标签时由本元素承担外部传入的宽度等样式
        label ? undefined : className,
      )}
    >
      {icon}
      <input
        id={id}
        value={value}
        disabled={disabled}
        required={required}
        aria-invalid={hasError || undefined}
        aria-describedby={
          description || errorMessage ? descriptionId : undefined
        }
        onChange={(e) => onChange?.(e.target.value)}
        className="font-zh text-body text-fg placeholder:text-fg-tertiary min-w-0 flex-1 border-none bg-transparent outline-none"
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
            "font-zh text-label",
            errorMessage ? "text-error" : "text-fg-tertiary",
          )}
        >
          {errorMessage ?? description}
        </p>
      )}
    </div>
  );
}
