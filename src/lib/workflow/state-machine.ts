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
  /** 执行该步骤的 Agent 名(研研究/写写作 等);可选,不填为默认智能体 */
  readonly agent?: string | undefined;
  /** 需要人工确认闸门:执行到该步骤前停下,等用户批准后才继续 */
  readonly needsApproval?: boolean | undefined;
  /** 需要人工输入闸门:执行到该步骤前停下,等用户提交输入后才继续。
   *   inputLabel 描述要什么(如「粘贴本月销售数据」)。 */
  readonly needsInput?: boolean | undefined;
  readonly inputLabel?: string | undefined;
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
    const step = item as {
      id?: unknown;
      title?: unknown;
      prompt?: unknown;
      agent?: unknown;
      needsApproval?: unknown;
      needsInput?: unknown;
      inputLabel?: unknown;
    };
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
    const agent = typeof step.agent === "string" ? step.agent.trim() : "";
    if (agent.length > 30) {
      throw new Error("Agent 名最多 30 字。");
    }
    const inputLabel = typeof step.inputLabel === "string" ? step.inputLabel.trim() : "";
    if (inputLabel.length > 200) {
      throw new Error("输入说明最多 200 字。");
    }
    steps.push({
      id: step.id,
      title,
      prompt,
      ...(agent ? { agent } : {}),
      ...(step.needsApproval === true ? { needsApproval: true } : {}),
      ...(step.needsInput === true ? { needsInput: true, ...(inputLabel ? { inputLabel } : {}) } : {}),
    });
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
