import { cn } from "@/lib/cn";

export interface UsageMeterProps {
  label: string;
  used: number;
  total: number;
  unit?: string | undefined;
  className?: string | undefined;
}

export function UsageMeter({
  label,
  used,
  total,
  unit = "",
  className,
}: UsageMeterProps) {
  // total 为 0 时不做除法 —— 避免 NaN 宽度悄悄渲染成空条
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;

  return (
    <div className={cn("font-zh flex flex-col gap-1.5", className)}>
      <div className="text-fg-secondary flex justify-between gap-3 text-[13px]">
        <span>{label}</span>
        <span className="text-fg-tertiary font-mono">
          {used.toLocaleString()} / {total.toLocaleString()}
          {unit}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="bg-surface-3 h-1.5 overflow-hidden rounded-[3px]"
      >
        <div
          style={{ width: `${pct}%` }}
          className={cn("h-full", pct > 90 ? "bg-warning" : "bg-brand")}
        />
      </div>
    </div>
  );
}
