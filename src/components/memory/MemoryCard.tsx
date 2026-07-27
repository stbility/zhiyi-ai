"use client";

import { Icon } from "@/components/icons/Icon";
import { IconButton } from "@/components/primitives/IconButton";
import { Switch } from "@/components/primitives/Switch";
import { cn } from "@/lib/cn";

import {
  MemorySourceBadge,
  type MemorySource,
} from "./MemorySourceBadge";

export interface MemoryCardProps {
  category: string;
  content: string;
  source?: MemorySource | undefined;
  createdAt: string;
  lastUsedAt: string;
  /** 置信度百分比。仅 AI 推断的记忆有此值,用户确认的事实不显示置信度。 */
  confidence?: number | undefined;
  scope?: string | undefined;
  recallEnabled?: boolean | undefined;
  onToggleRecall?: ((enabled: boolean) => void) | undefined;
  onEdit?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  className?: string | undefined;
}

export function MemoryCard({
  category,
  content,
  source = "inferred",
  createdAt,
  lastUsedAt,
  confidence,
  scope,
  recallEnabled = true,
  onToggleRecall,
  onEdit,
  onDelete,
  className,
}: MemoryCardProps) {
  return (
    <div
      className={cn(
        "bg-surface-2 border-border-default rounded-card font-zh flex flex-col gap-2.5 border p-5",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-brand text-label font-medium">{category}</span>
        <MemorySourceBadge source={source} />
      </div>

      <p className="text-fg text-body">{content}</p>

      <div className="text-fg-tertiary text-label flex flex-wrap gap-3.5">
        <span>创建于 {createdAt}</span>
        <span>最近使用 {lastUsedAt}</span>
        {confidence != null && <span>置信度 {confidence}%</span>}
        {scope && <span>范围 · {scope}</span>}
      </div>

      <div className="border-divider mt-1 flex items-center justify-between gap-3 border-t pt-2.5">
        <span className="text-fg-secondary text-label flex items-center gap-2">
          <Switch
            checked={recallEnabled}
            onChange={onToggleRecall}
            label="允许 AI 调用这条记忆"
          />
          允许调用
        </span>
        <span className="flex gap-1">
          <IconButton aria-label="编辑" onClick={onEdit} size={30}>
            <Icon name="edit" size={15} />
          </IconButton>
          <IconButton aria-label="删除" onClick={onDelete} size={30}>
            <Icon name="trash" size={15} className="text-error" />
          </IconButton>
        </span>
      </div>
    </div>
  );
}
