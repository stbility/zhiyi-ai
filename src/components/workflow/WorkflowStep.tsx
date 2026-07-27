import { cn } from "@/lib/cn";

import { AgentBadge } from "./AgentBadge";
import {
  WorkflowStatusBadge,
  type WorkflowStatus,
} from "./WorkflowStatusBadge";

export interface WorkflowStepProps {
  title: string;
  status?: WorkflowStatus | undefined;
  agent?: string | undefined;
  timestamp?: string | undefined;
  isLast?: boolean | undefined;
}

/** 时间线圆点配色 —— 与状态徽章的语义色保持一致 */
function dotClass(status: WorkflowStatus | undefined): string {
  switch (status) {
    case "COMPLETED":
      return "bg-success";
    case "FAILED":
      return "bg-error";
    case "RUNNING":
      return "bg-brand";
    case "WAITING_FOR_APPROVAL":
      return "bg-warning";
    case "WAITING_FOR_INPUT":
    case "QUEUED":
      return "bg-info";
    default:
      return "bg-border-strong";
  }
}

export function WorkflowStep({
  title,
  status = "DRAFT",
  agent,
  timestamp,
  isLast = false,
}: WorkflowStepProps) {
  return (
    <div className="font-zh flex gap-3.5">
      <div className="flex flex-col items-center">
        <span
          aria-hidden
          className={cn("mt-1 size-2.5 rounded-full", dotClass(status))}
        />
        {!isLast && (
          <span aria-hidden className="bg-border-default mt-1 w-px flex-1" />
        )}
      </div>

      <div className="flex-1 pb-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-fg text-[14px]">{title}</span>
          <WorkflowStatusBadge status={status} />
          {agent && <AgentBadge name={agent} />}
        </div>
        {timestamp && (
          <div className="text-fg-tertiary text-label mt-1 font-mono">
            {timestamp}
          </div>
        )}
      </div>
    </div>
  );
}
