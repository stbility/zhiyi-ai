import { WorkflowStep, type WorkflowStepProps } from "./WorkflowStep";

export type WorkflowTimelineStep = Omit<WorkflowStepProps, "isLast"> & {
  id: string;
};

export interface WorkflowTimelineProps {
  steps?: readonly WorkflowTimelineStep[] | undefined;
  className?: string | undefined;
}

export function WorkflowTimeline({
  steps = [],
  className,
}: WorkflowTimelineProps) {
  return (
    <div className={className}>
      {steps.map((step, index) => {
        const { id, ...rest } = step;
        return (
          <WorkflowStep key={id} {...rest} isLast={index === steps.length - 1} />
        );
      })}
    </div>
  );
}
