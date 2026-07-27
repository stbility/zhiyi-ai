import { Icon } from "@/components/icons/Icon";
import { cn } from "@/lib/cn";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastProps {
  tone?: ToastTone | undefined;
  message: string;
  onClose?: (() => void) | undefined;
}

const DOT: Record<ToastTone, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
};

export function Toast({ tone = "info", message, onClose }: ToastProps) {
  return (
    <div
      role="status"
      className="bg-surface-3 border-border-strong shadow-dropdown font-zh flex min-w-65 items-center gap-2.5 rounded-[10px] border px-3.5 py-2.5"
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[tone])} />
      <span className="text-fg text-caption flex-1">{message}</span>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭提示"
          className="text-fg-tertiary hover:text-fg-secondary cursor-pointer transition-colors duration-[var(--duration-hover)] ease-standard"
        >
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}
