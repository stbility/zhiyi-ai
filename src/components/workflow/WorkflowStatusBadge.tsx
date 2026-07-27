import { cn } from "@/lib/cn";

/**
 * 工作流状态徽章。
 *
 * 设计系统原实现只有 7 个状态(notStarted / waitingInput / processing /
 * waitingConfirm / done / failed / paused)。产品需求要求 10 个状态,
 * 这里按需求扩展,并沿用设计系统既有的 tone 与配色语言 —— 扩展映射表,
 * 不重写组件。
 *
 * 与原有 7 态的对应关系:
 *   notStarted     → DRAFT / READY(原本混为一态,需求要求区分)
 *   (新增)        → QUEUED
 *   processing     → RUNNING
 *   waitingInput   → WAITING_FOR_INPUT
 *   waitingConfirm → WAITING_FOR_APPROVAL
 *   paused         → PAUSED
 *   done           → COMPLETED
 *   failed         → FAILED
 *   (新增)        → CANCELLED
 */

export const WORKFLOW_STATUSES = [
  "DRAFT",
  "READY",
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_INPUT",
  "WAITING_FOR_APPROVAL",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

type Tone = "neutral" | "info" | "brand" | "warning" | "success" | "error";

interface StatusMeta {
  readonly label: string;
  readonly tone: Tone;
  /** 是否为「运行中」的活跃态,活跃态的状态点呼吸闪烁 */
  readonly active?: boolean;
  /** 是否为终态,不会再自行流转 */
  readonly terminal?: boolean;
}

export const WORKFLOW_STATUS: Record<WorkflowStatus, StatusMeta> = {
  DRAFT: { label: "草稿", tone: "neutral" },
  READY: { label: "就绪", tone: "neutral" },
  QUEUED: { label: "排队中", tone: "info" },
  RUNNING: { label: "AI 处理中", tone: "brand", active: true },
  WAITING_FOR_INPUT: { label: "等待输入", tone: "info" },
  WAITING_FOR_APPROVAL: { label: "等待确认", tone: "warning" },
  PAUSED: { label: "已暂停", tone: "neutral" },
  COMPLETED: { label: "已完成", tone: "success", terminal: true },
  FAILED: { label: "执行失败", tone: "error", terminal: true },
  CANCELLED: { label: "已取消", tone: "neutral", terminal: true },
};

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-surface-3 text-fg-tertiary",
  info: "bg-info-tint text-info",
  brand: "bg-brand-tint text-brand",
  warning: "bg-warning-tint text-warning",
  success: "bg-success-tint text-success",
  error: "bg-error-tint text-error",
};

export interface WorkflowStatusBadgeProps {
  status?: WorkflowStatus | undefined;
  className?: string | undefined;
}

export function WorkflowStatusBadge({
  status = "DRAFT",
  className,
}: WorkflowStatusBadgeProps) {
  const meta = WORKFLOW_STATUS[status];

  return (
    <span
      className={cn(
        "font-zh text-label rounded-tag inline-flex items-center gap-1.5 px-2 py-[3px] font-medium",
        TONE_CLASS[meta.tone],
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full bg-current",
          meta.active && "animate-status-pulse",
        )}
      />
      {meta.label}
    </span>
  );
}
