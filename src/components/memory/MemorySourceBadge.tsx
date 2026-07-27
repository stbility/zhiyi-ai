import { Icon } from "@/components/icons/Icon";
import { cn } from "@/lib/cn";

/**
 * 记忆来源徽章。
 *
 * 产品规则:AI 推断与用户确认的事实必须明确区分,绝不把推断陈述为事实。
 * 这个徽章是该规则在界面上的唯一承载,来源枚举不得含糊或合并。
 */
export const MEMORY_SOURCES = [
  "inferred",
  "confirmed",
  "file",
  "workflow",
] as const;

export type MemorySource = (typeof MEMORY_SOURCES)[number];

type Tone = "brand" | "success" | "info" | "neutral";

const SOURCE: Record<MemorySource, { label: string; tone: Tone }> = {
  inferred: { label: "AI 自动推断", tone: "brand" },
  confirmed: { label: "用户明确保存", tone: "success" },
  file: { label: "从文件提取", tone: "info" },
  workflow: { label: "从工作流生成", tone: "neutral" },
};

const TONE_CLASS: Record<Tone, string> = {
  brand: "bg-brand-tint text-brand",
  success: "bg-success-tint text-success",
  info: "bg-info-tint text-info",
  neutral: "bg-surface-3 text-fg-tertiary",
};

export interface MemorySourceBadgeProps {
  source?: MemorySource | undefined;
  className?: string | undefined;
}

export function MemorySourceBadge({
  source = "inferred",
  className,
}: MemorySourceBadgeProps) {
  const meta = SOURCE[source];

  return (
    <span
      className={cn(
        "font-zh rounded-tag inline-flex items-center gap-[5px] px-2 py-[3px] text-[11px] font-medium",
        TONE_CLASS[meta.tone],
        className,
      )}
    >
      {source === "inferred" && <Icon name="assistant" size={11} />}
      {meta.label}
    </span>
  );
}
