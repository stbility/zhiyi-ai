import { Icon } from "@/components/icons/Icon";
import { cn } from "@/lib/cn";

import { AgentBadge } from "./AgentBadge";
import {
  WorkflowStatusBadge,
  type WorkflowStatus,
} from "./WorkflowStatusBadge";

export interface WorkflowCardProps {
  name: string;
  goal?: string | undefined;
  status?: WorkflowStatus | undefined;
  currentStep?: string | undefined;
  agents?: readonly string[] | undefined;
  lastRun?: string | undefined;
  onOpen?: (() => void) | undefined;
  className?: string | undefined;
}

export function WorkflowCard({
  name,
  goal,
  status = "DRAFT",
  currentStep,
  agents = [],
  lastRun,
  onOpen,
  className,
}: WorkflowCardProps) {
  const interactive = typeof onOpen === "function";

  const content = (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="text-fg text-h3 flex items-center gap-2 font-medium">
          <Icon name="workflow" size={16} className="text-brand shrink-0" />
          {name}
        </span>
        <WorkflowStatusBadge status={status} />
      </div>

      {goal && <p className="text-fg-secondary text-caption">{goal}</p>}

      {currentStep && (
        <p className="text-fg-tertiary text-label">当前步骤 · {currentStep}</p>
      )}

      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="flex flex-wrap gap-1.5">
          {agents.map((agent) => (
            <AgentBadge key={agent} name={agent} />
          ))}
        </span>
        {lastRun && (
          <span className="text-fg-disabled shrink-0 font-mono text-[11px]">
            {lastRun}
          </span>
        )}
      </div>
    </>
  );

  const classes = cn(
    "bg-surface-2 border-border-default rounded-card font-zh flex flex-col gap-2.5 border p-5 text-left",
    interactive &&
      "hover:border-border-strong cursor-pointer transition-colors duration-[var(--duration-hover)] ease-standard",
    className,
  );

  if (interactive) {
    return (
      <button type="button" onClick={onOpen} className={classes}>
        {content}
      </button>
    );
  }

  return <div className={classes}>{content}</div>;
}
