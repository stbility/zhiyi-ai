import { Icon } from "@/components/icons/Icon";
import {
  WorkflowStatusBadge,
  type WorkflowStatus,
} from "@/components/workflow/WorkflowStatusBadge";
import { cn } from "@/lib/cn";

export interface BriefWorkflow {
  id: string;
  name: string;
  status: WorkflowStatus;
}

export interface DailyBriefCardProps {
  date: string;
  greeting: string;
  priorities?: readonly string[] | undefined;
  runningWorkflows?: readonly BriefWorkflow[] | undefined;
  pendingConfirmations?: readonly string[] | undefined;
  className?: string | undefined;
}

export function DailyBriefCard({
  date,
  greeting,
  priorities = [],
  runningWorkflows = [],
  pendingConfirmations = [],
  className,
}: DailyBriefCardProps) {
  return (
    <section
      className={cn(
        "bg-surface-2 border-border-default rounded-panel font-zh flex max-w-180 flex-col gap-[18px] border p-7",
        className,
      )}
    >
      <div>
        <p className="text-fg-tertiary text-caption font-mono">{date}</p>
        <h2 className="text-fg text-h2 mt-1 font-semibold">{greeting}</h2>
      </div>

      {priorities.length > 0 && (
        <div>
          <p className="text-fg-tertiary text-label mb-2">今天最重要的事</p>
          <ul className="flex flex-col gap-2">
            {priorities.map((item) => (
              <li
                key={item}
                className="text-fg flex items-center gap-2 text-[14px]"
              >
                <Icon name="check" size={14} className="text-brand shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-6">
        {runningWorkflows.length > 0 && (
          <div className="min-w-55 flex-1">
            <p className="text-fg-tertiary text-label mb-2">正在运行的工作流</p>
            <ul className="flex flex-col gap-1.5">
              {runningWorkflows.map((workflow) => (
                <li
                  key={workflow.id}
                  className="text-fg-secondary flex items-center justify-between gap-3 text-[13px]"
                >
                  {workflow.name}
                  <WorkflowStatusBadge status={workflow.status} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {pendingConfirmations.length > 0 && (
          <div className="min-w-55 flex-1">
            <p className="text-fg-tertiary text-label mb-2">待您确认</p>
            <ul className="flex flex-col gap-1.5">
              {pendingConfirmations.map((item) => (
                <li key={item} className="text-fg-secondary text-[13px]">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
