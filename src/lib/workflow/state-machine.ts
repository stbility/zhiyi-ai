import {
  WORKFLOW_STATUSES,
  type WorkflowStatus,
} from "@/components/workflow/WorkflowStatusBadge";

/**
 * 工作流状态机(单一事实源:设计系统 WorkflowStatusBadge)。
 *
 * 迁移 0036 的 CHECK 约束、页面动作、契约测试全部以这里为准。
 * 改状态必须先过 assertTransition —— 非法迁移在到达数据库前就被拦下。
 */

/** 每一步的合法去向。终态(COMPLETED/CANCELLED)没有出边。 */
export const WORKFLOW_TRANSITIONS: Readonly<
  Record<WorkflowStatus, readonly WorkflowStatus[]>
> = {
  DRAFT: ["READY"],
  READY: ["QUEUED", "PAUSED", "CANCELLED", "DRAFT"],
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["WAITING_FOR_INPUT", "WAITING_FOR_APPROVAL", "COMPLETED", "FAILED", "PAUSED"],
  WAITING_FOR_INPUT: ["RUNNING", "CANCELLED"],
  WAITING_FOR_APPROVAL: ["RUNNING", "CANCELLED"],
  PAUSED: ["READY", "QUEUED", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["QUEUED", "CANCELLED"],
  CANCELLED: [],
};

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: WorkflowStatus, to: WorkflowStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`状态迁移不合法:${from} → ${to}`);
  }
}

export interface WorkflowStep {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
}

export interface WorkflowDefinition {
  readonly steps: readonly WorkflowStep[];
}

/** v1 同步执行的步数上限(诚实护栏:Worker 版本解除) */
export const MAX_STEPS_PER_RUN = 5;

export function parseDefinition(raw: unknown): WorkflowDefinition {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("工作流定义无效。");
  }
  const candidate = raw as { steps?: unknown };
  if (!Array.isArray(candidate.steps)) {
    throw new Error("工作流必须包含步骤列表。");
  }
  const steps: WorkflowStep[] = [];
  for (const item of candidate.steps) {
    if (typeof item !== "object" || item === null) {
      throw new Error("步骤格式无效。");
    }
    const step = item as { id?: unknown; title?: unknown; prompt?: unknown };
    if (typeof step.id !== "string" || step.id.length === 0 || step.id.length > 40) {
      throw new Error("步骤 id 无效。");
    }
    const title = typeof step.title === "string" ? step.title.trim() : "";
    const prompt = typeof step.prompt === "string" ? step.prompt.trim() : "";
    if (title.length === 0 || title.length > 100) {
      throw new Error("步骤标题需为 1-100 字。");
    }
    if (prompt.length === 0 || prompt.length > 4000) {
      throw new Error("步骤指令需为 1-4000 字。");
    }
    steps.push({ id: step.id, title, prompt });
  }
  if (steps.length === 0) {
    throw new Error("至少需要一个步骤。");
  }
  if (steps.length > MAX_STEPS_PER_RUN) {
    throw new Error(`v1 同步执行最多 ${MAX_STEPS_PER_RUN} 步(后台 Worker 版本解除)。`);
  }
  return { steps };
}

export { WORKFLOW_STATUSES };
export type { WorkflowStatus };
