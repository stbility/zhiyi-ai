import { parseDefinition, type WorkflowStatus } from "@/lib/workflow/state-machine";
import { readAgentStream } from "@/lib/ai/read-agent-stream";
import { getSiteUrl } from "@/lib/env/server";
import { saveWorkflowMemory } from "@/lib/db/memories";
import type { SupabaseClient } from "@supabase/supabase-js";

/** 运行中一个步骤的结果(含两种人工闸门占位) */
export interface StepResult {
  readonly stepId: string;
  readonly title: string;
  readonly output?: string;
  readonly error?: string;
  readonly agent?: string;
  /** 显式状态;无则 UI 按位置推断 */
  readonly status?:
    | "COMPLETED"
    | "FAILED"
    | "WAITING_FOR_APPROVAL"
    | "WAITING_FOR_INPUT";
}

export interface RunOutput {
  readonly steps?: StepResult[];
  readonly paused_step_index?: number;
  /** needsInput 闸门暂停时用户提交的输入,续跑时拼进步骤指令 */
  readonly pending_input?: string;
}

/** 执行器需要的上下文 —— 由调用方(server action / worker route)提供,
 *  不依赖 server-only 的 cookies,Worker 场景可复用。 */
export interface WorkflowExecContext {
  supabase: SupabaseClient;
  organizationId: string;
  userId: string;
}

export type ExecuteResult = {
  paused?: boolean;
  pausedStepTitle?: string;
  ok?: string;
  error?: string;
};

/**
 * 工作流步骤执行器(2026-08-12 从 server action 抽出,worker 复用)。
 *
 * 循环执行步骤:
 *   · needsInput     → 停下,置 WAITING_FOR_INPUT(等用户提交输入)
 *   · needsApproval  → 停下,置 WAITING_FOR_APPROVAL(等用户批准)
 *   · 其余            → 调 /api/agent 执行(agent 工具循环、产物写工作区)
 *
 * 暂停位置记在 run.output.paused_step_index,续跑从 pausedIndex+1 开始。
 * 完成时最终产物沉淀为 AI 记忆(from_workflow),失败不阻断运行。
 */
export async function executeWorkflowSteps(
  ctx: WorkflowExecContext,
  workflowId: string,
  runId: string,
  definition: ReturnType<typeof parseDefinition>,
  startIndex: number,
  cookieHeader: string,
): Promise<ExecuteResult> {
  const { data: run } = await ctx.supabase
    .from("workflow_runs")
    .select("output")
    .eq("id", runId)
    .maybeSingle();
  const output = (run?.output as RunOutput | null) ?? {};
  const stepResults: StepResult[] = Array.isArray(output.steps)
    ? (output.steps as StepResult[])
    : [];

  const setRun = (status: WorkflowStatus, extra: Record<string, unknown> = {}) =>
    ctx.supabase
      .from("workflow_runs")
      .update({ status, ...extra })
      .eq("id", runId);
  const setWorkflow = (status: WorkflowStatus) =>
    ctx.supabase
      .from("workflows")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", workflowId);

  for (let i = startIndex; i < definition.steps.length; i++) {
    const step = definition.steps[i]!; // parseDefinition 已保证步骤合法且至少 1 个

    // 输入闸门:执行前停下,等用户提交输入(用户输入在续跑时拼进 prompt)
    if (step.needsInput) {
      stepResults.push({
        stepId: step.id,
        title: step.title,
        status: "WAITING_FOR_INPUT",
      });
      await setRun("WAITING_FOR_INPUT", {
        output: { steps: stepResults, paused_step_index: i },
      });
      await setWorkflow("WAITING_FOR_INPUT");
      return { paused: true, pausedStepTitle: step.title };
    }

    // 审批闸门:执行前停下,等用户确认
    if (step.needsApproval) {
      stepResults.push({
        stepId: step.id,
        title: step.title,
        status: "WAITING_FOR_APPROVAL",
      });
      await setRun("WAITING_FOR_APPROVAL", {
        output: { steps: stepResults, paused_step_index: i },
      });
      await setWorkflow("WAITING_FOR_APPROVAL");
      return { paused: true, pausedStepTitle: step.title };
    }

    try {
      // 暂停恢复时,若该步骤等待过输入,把用户提交的输入拼进指令
      const pendingInput = output.pending_input;
      const effectivePrompt =
        startIndex > 0 && pendingInput && pendingInput.trim() !== ""
          ? `${step.prompt}\n\n[用户补充输入]\n${pendingInput}`
          : step.prompt;

      const res = await fetch(`${getSiteUrl()}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        body: JSON.stringify({ input: effectivePrompt }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `步骤失败(HTTP ${res.status})`);
      }
      const stepOutput = await readAgentStream(res);
      stepResults.push({
        stepId: step.id,
        title: step.title,
        ...(step.agent ? { agent: step.agent } : {}),
        output: stepOutput,
        status: "COMPLETED",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      stepResults.push({
        stepId: step.id,
        title: step.title,
        error: message,
        status: "FAILED",
      });
      await setRun("FAILED", {
        finished_at: new Date().toISOString(),
        error: message,
        output: { steps: stepResults },
      });
      await setWorkflow("FAILED");
      return { error: `工作流执行失败:${message}` };
    }
  }

  await setRun("COMPLETED", {
    finished_at: new Date().toISOString(),
    output: { steps: stepResults },
  });
  await setWorkflow("READY");

  // 闭环最后一环:最终产物沉淀为记忆(from_workflow)。失败不阻断运行。
  const lastStep = stepResults[stepResults.length - 1];
  if (lastStep?.output && lastStep.output.trim() !== "") {
    const result = await saveWorkflowMemory(ctx.supabase, {
      organizationId: ctx.organizationId,
      createdBy: ctx.userId,
      content: lastStep.output,
    });
    if (!result.ok) {
      ctx.supabase
        .from("workflow_runs")
        .update({ output: { steps: stepResults, memory_note: result.error } })
        .eq("id", runId);
    }
  }

  return {
    ok: `已完成 ${definition.steps.length} 个步骤,最终产物已沉淀为 AI 记忆。`,
  };
}
