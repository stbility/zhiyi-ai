"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getMyOrganizations } from "@/lib/db/queries";
import { getMyEntitlements, quotaOf } from "@/lib/billing/entitlements";
import {
  assertTransition,
  parseDefinition,
  type WorkflowStatus,
  type WorkflowStep,
} from "@/lib/workflow/state-machine";

export interface WorkflowActionResult {
  readonly ok?: string;
  readonly error?: string;
}

const idSchema = z.string().uuid("标识无效");
const nameSchema = z.string().trim().min(1, "名称不能为空").max(100, "名称最多 100 字");
const goalSchema = z.string().trim().max(500, "目标描述最多 500 字").optional();

const stepSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().trim().min(1, "步骤标题不能为空").max(100),
  prompt: z.string().trim().min(1, "步骤指令不能为空").max(4000),
});
const stepsSchema = z
  .array(stepSchema)
  .min(1, "至少需要一个步骤")
  .max(5, "v1 同步执行最多 5 步(后台 Worker 版本解除)");

async function requireWorkflowContext() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" } as const;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "请先登录。" } as const;
  const organizations = await getMyOrganizations();
  const organization = organizations?.[0];
  if (!organization) return { error: "没有可用的组织。" } as const;
  return { supabase, user, organization } as const;
}

async function enforceWorkflowQuota(
  supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>,
  organizationId: string,
): Promise<string | null> {
  const entitlements = await getMyEntitlements();
  // 【P0 fail-open 修复】此前这里写的是 `: null`。null 在 quota-math 里的
  // 语义是「不限额度」—— 于是 get_entitlements 一失败(RPC、网络、鉴权),
  // 工作流数量上限直接失效,谁都能无限建。智能体通道同一位置用的是 `: 0`
  // (拦截),两条线必须同一套纪律:**异常不等于放行**。
  const quota = entitlements ? quotaOf(entitlements, "workflows") : 0;
  if (!entitlements) {
    // 说实话:这是「查不到权益」,不是「你的套餐只有 0 个」——
    // 后者会让付费用户以为自己买的东西没了。
    return "暂时无法确认当前套餐权益,请稍后重试。";
  }
  if (quota === null) return null; // 不限(Enterprise)
  const { count } = await supabase
    .from("workflows")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .neq("status", "CANCELLED");
  if ((count ?? 0) >= quota) {
    return `工作流数量已达当前套餐上限(${quota} 个)。升级套餐可提升上限。`;
  }
  return null;
}

export async function createWorkflow(
  name: string,
  goal: string | undefined,
  steps: readonly WorkflowStep[],
): Promise<WorkflowActionResult> {
  const ctx = await requireWorkflowContext();
  if ("error" in ctx) return { error: ctx.error };

  const nameParsed = nameSchema.safeParse(name);
  if (!nameParsed.success) return { error: nameParsed.error.issues[0]?.message ?? "输入无效" };
  const goalParsed = goalSchema.safeParse(goal);
  if (!goalParsed.success) return { error: goalParsed.error.issues[0]?.message ?? "输入无效" };
  const stepsParsed = stepsSchema.safeParse(steps);
  if (!stepsParsed.success) return { error: stepsParsed.error.issues[0]?.message ?? "输入无效" };

  const quotaError = await enforceWorkflowQuota(ctx.supabase, ctx.organization.id);
  if (quotaError) return { error: quotaError };

  const { error } = await ctx.supabase.from("workflows").insert({
    organization_id: ctx.organization.id,
    name: nameParsed.data,
    goal: goalParsed.data ?? "",
    definition: { steps: stepsParsed.data },
    status: "DRAFT",
    created_by: ctx.user.id,
  });
  if (error) return { error: error.message };

  revalidatePath("/workflow");
  return { ok: "工作流已创建(草稿)。" };
}

export async function updateWorkflow(
  id: string,
  name: string,
  goal: string | undefined,
  steps: readonly WorkflowStep[],
): Promise<WorkflowActionResult> {
  const ctx = await requireWorkflowContext();
  if ("error" in ctx) return { error: ctx.error };

  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { error: idParsed.error.issues[0]?.message ?? "输入无效" };
  const nameParsed = nameSchema.safeParse(name);
  if (!nameParsed.success) return { error: nameParsed.error.issues[0]?.message ?? "输入无效" };
  const goalParsed = goalSchema.safeParse(goal);
  if (!goalParsed.success) return { error: goalParsed.error.issues[0]?.message ?? "输入无效" };
  const stepsParsed = stepsSchema.safeParse(steps);
  if (!stepsParsed.success) return { error: stepsParsed.error.issues[0]?.message ?? "输入无效" };

  const { data: existing } = await ctx.supabase
    .from("workflows")
    .select("status")
    .eq("id", idParsed.data)
    .maybeSingle();
  if (!existing) return { error: "工作流不存在。" };
  // 编辑即回到草稿:READY → DRAFT 合法,终态/运行中不可编辑
  if (existing.status !== "DRAFT") {
    try {
      assertTransition(existing.status as WorkflowStatus, "DRAFT");
    } catch (e) {
      return { error: e instanceof Error ? e.message : "当前状态不可编辑。" };
    }
  }

  const { error } = await ctx.supabase
    .from("workflows")
    .update({
      name: nameParsed.data,
      goal: goalParsed.data ?? "",
      definition: { steps: stepsParsed.data },
      status: "DRAFT",
      updated_at: new Date().toISOString(),
    })
    .eq("id", idParsed.data);
  if (error) return { error: error.message };

  revalidatePath("/workflow");
  return { ok: "已保存(回到草稿,重新就绪后可运行)。" };
}

async function transitionWorkflow(
  supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>,
  id: string,
  to: WorkflowStatus,
): Promise<WorkflowActionResult | null> {
  const { data: existing } = await supabase
    .from("workflows")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { error: "工作流不存在。" };
  try {
    assertTransition(existing.status as WorkflowStatus, to);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "状态迁移不合法。" };
  }
  const { error } = await supabase
    .from("workflows")
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { error: error.message };
  return null;
}

export async function markReady(id: string): Promise<WorkflowActionResult> {
  const ctx = await requireWorkflowContext();
  if ("error" in ctx) return { error: ctx.error };
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { error: idParsed.error.issues[0]?.message ?? "输入无效" };

  const { data: workflow } = await ctx.supabase
    .from("workflows")
    .select("definition")
    .eq("id", idParsed.data)
    .maybeSingle();
  if (!workflow) return { error: "工作流不存在。" };
  try {
    parseDefinition(workflow.definition); // 步骤不合法就拒绝就绪
  } catch (e) {
    return { error: e instanceof Error ? e.message : "步骤定义无效。" };
  }
  const failed = await transitionWorkflow(ctx.supabase, idParsed.data, "READY");
  if (failed) return failed;
  revalidatePath("/workflow");
  return { ok: "已就绪,可以运行。" };
}

export async function pauseWorkflow(id: string): Promise<WorkflowActionResult> {
  const ctx = await requireWorkflowContext();
  if ("error" in ctx) return { error: ctx.error };
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { error: idParsed.error.issues[0]?.message ?? "输入无效" };
  const failed = await transitionWorkflow(ctx.supabase, idParsed.data, "PAUSED");
  if (failed) return failed;
  revalidatePath("/workflow");
  return { ok: "已暂停。" };
}

export async function resumeWorkflow(id: string): Promise<WorkflowActionResult> {
  const ctx = await requireWorkflowContext();
  if ("error" in ctx) return { error: ctx.error };
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { error: idParsed.error.issues[0]?.message ?? "输入无效" };
  const failed = await transitionWorkflow(ctx.supabase, idParsed.data, "READY");
  if (failed) return failed;
  revalidatePath("/workflow");
  return { ok: "已恢复就绪。" };
}

export async function cancelWorkflow(id: string): Promise<WorkflowActionResult> {
  const ctx = await requireWorkflowContext();
  if ("error" in ctx) return { error: ctx.error };
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { error: idParsed.error.issues[0]?.message ?? "输入无效" };
  const failed = await transitionWorkflow(ctx.supabase, idParsed.data, "CANCELLED");
  if (failed) return failed;
  revalidatePath("/workflow");
  return { ok: "已取消。" };
}

export async function deleteWorkflow(id: string): Promise<WorkflowActionResult> {
  const ctx = await requireWorkflowContext();
  if ("error" in ctx) return { error: ctx.error };
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { error: idParsed.error.issues[0]?.message ?? "输入无效" };

  const { error, count } = await ctx.supabase
    .from("workflows")
    .delete({ count: "exact" })
    .eq("id", idParsed.data);
  if (error) return { error: error.message };
  if ((count ?? 0) === 0) return { error: "只能删除自己的工作流。" };

  revalidatePath("/workflow");
  return { ok: "已删除。" };
}

import {
  executeWorkflowSteps,
  type RunOutput,
} from "@/lib/workflow/execute";

export async function runWorkflow(id: string): Promise<WorkflowActionResult> {
  const ctx = await requireWorkflowContext();
  if ("error" in ctx) return { error: ctx.error };
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { error: idParsed.error.issues[0]?.message ?? "输入无效" };

  const { data: workflow } = await ctx.supabase
    .from("workflows")
    .select("id, definition, status")
    .eq("id", idParsed.data)
    .maybeSingle();
  if (!workflow) return { error: "工作流不存在。" };

  // READY/FAILED/PAUSED → QUEUED(入队);终态不可重跑
  try {
    assertTransition(workflow.status as WorkflowStatus, "QUEUED");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "当前状态不可运行。" };
  }

  // 并发数权益(0055 concurrent_tasks):入队前检查,与 agent 入口同一实现。
  // worker 步骤带 x-zhiyi-worker 跳过 agent 侧检查,此处是唯一检查点。
  const { checkConcurrentTasks } = await import("@/lib/billing/concurrency");
  const concurrencyBlocked = await checkConcurrentTasks({
    supabase: ctx.supabase as never,
    userId: ctx.user.id,
    organizationId: ctx.organization.id,
  });
  if (concurrencyBlocked.blocked) {
    return { error: concurrencyBlocked.reason };
  }

  // 入队(QUEUED):不在这里同步执行 —— 前端轮询 /api/workflow/worker
  // 带用户身份执行(2026-08-12 Worker 化)。Worker 复用 executeWorkflowSteps,
  // 与人工闸门(等待输入/确认)共用同一执行器。
  await ctx.supabase
    .from("workflows")
    .update({ status: "QUEUED", updated_at: new Date().toISOString() })
    .eq("id", idParsed.data);
  const { data: run, error: runError } = await ctx.supabase
    .from("workflow_runs")
    .insert({ workflow_id: idParsed.data, status: "QUEUED", trigger_source: "manual" })
    .select("id")
    .single();
  if (runError || !run) {
    await ctx.supabase
      .from("workflows")
      .update({ status: "FAILED", updated_at: new Date().toISOString() })
      .eq("id", idParsed.data);
    return { error: `无法创建运行记录:${runError?.message ?? "未知错误"}` };
  }

  revalidatePath("/workflow");
  return { ok: "已排队,正在后台执行…", queuedRunId: run.id } as WorkflowActionResult & {
    queuedRunId?: string;
  };
}

export async function approveWorkflowStep(
  workflowId: string,
  runId: string,
  approve: boolean,
): Promise<WorkflowActionResult> {
  const ctx = await requireWorkflowContext();
  if ("error" in ctx) return { error: ctx.error };
  const workflowIdParsed = idSchema.safeParse(workflowId);
  if (!workflowIdParsed.success) return { error: "工作流标识无效。" };
  const runIdParsed = idSchema.safeParse(runId);
  if (!runIdParsed.success) return { error: "运行标识无效。" };

  const { data: run } = await ctx.supabase
    .from("workflow_runs")
    .select("status, output")
    .eq("id", runIdParsed.data)
    .eq("workflow_id", workflowIdParsed.data)
    .maybeSingle();
  if (!run) return { error: "运行记录不存在。" };
  if (!["WAITING_FOR_APPROVAL", "WAITING_FOR_INPUT"].includes(run.status)) {
    return { error: "该运行不在等待确认/输入状态。" };
  }
  const output = (run.output as RunOutput | null) ?? {};
  const pausedIndex = output.paused_step_index;
  if (typeof pausedIndex !== "number" || pausedIndex < 0) {
    return { error: "运行缺少暂停位置。" };
  }

  const { data: workflow } = await ctx.supabase
    .from("workflows")
    .select("definition")
    .eq("id", workflowIdParsed.data)
    .maybeSingle();
  if (!workflow) return { error: "工作流不存在。" };
  let definition;
  try {
    definition = parseDefinition(workflow.definition);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "步骤定义无效。" };
  }
  const pausedStep = definition.steps[pausedIndex];

  if (!approve) {
    await ctx.supabase
      .from("workflow_runs")
      .update({
        status: "CANCELLED",
        finished_at: new Date().toISOString(),
        error: `步骤「${pausedStep?.title ?? "未知"}」被拒绝,运行取消。`,
      })
      .eq("id", runIdParsed.data);
    await ctx.supabase
      .from("workflows")
      .update({ status: "READY", updated_at: new Date().toISOString() })
      .eq("id", workflowIdParsed.data);
    revalidatePath("/workflow");
    return { ok: "已拒绝,运行取消。" };
  }

  // 批准:继续执行暂停点之后的步骤
  await ctx.supabase
    .from("workflow_runs")
    .update({ status: "RUNNING" })
    .eq("id", runIdParsed.data);
  await ctx.supabase
    .from("workflows")
    .update({ status: "RUNNING", updated_at: new Date().toISOString() })
    .eq("id", workflowIdParsed.data);

  const cookieHeader = (await cookies()).toString();
  // 从 pausedIndex 恢复,并传入 resolvedGateIndex:
  // 被闸门保护的步骤本身在批准后必须真正执行(state-machine.ts 语义)。
  const result = await executeWorkflowSteps(
    {
      supabase: ctx.supabase as never,
      organizationId: ctx.organization.id,
      userId: ctx.user.id,
    },
    workflowIdParsed.data,
    runIdParsed.data,
    definition,
    pausedIndex,
    cookieHeader,
    pausedIndex,
  );

  revalidatePath("/workflow");
  if (result.error) return { error: result.error };
  if (result.paused) {
    return { ok: `已在「${result.pausedStepTitle ?? "未知步骤"}」前停下,等待你的确认。` };
  }
  return { ok: result.ok ?? "完成。" };
}

/** 等待输入闸门:提交输入后从暂停点继续执行(2026-08-12 补全状态机承诺)。 */
export async function submitWorkflowInput(
  workflowId: string,
  runId: string,
  input: string,
): Promise<WorkflowActionResult> {
  const ctx = await requireWorkflowContext();
  if ("error" in ctx) return { error: ctx.error };
  const workflowIdParsed = idSchema.safeParse(workflowId);
  if (!workflowIdParsed.success) return { error: "工作流标识无效。" };
  const runIdParsed = idSchema.safeParse(runId);
  if (!runIdParsed.success) return { error: "运行标识无效。" };
  const inputTrimmed = input.trim();
  if (inputTrimmed.length === 0 || inputTrimmed.length > 4000) {
    return { error: "输入需为 1-4000 字。" };
  }

  const { data: run } = await ctx.supabase
    .from("workflow_runs")
    .select("status, output")
    .eq("id", runIdParsed.data)
    .eq("workflow_id", workflowIdParsed.data)
    .maybeSingle();
  if (!run) return { error: "运行记录不存在。" };
  if (run.status !== "WAITING_FOR_INPUT") {
    return { error: "该运行不在等待输入状态。" };
  }
  const output = (run.output as RunOutput | null) ?? {};
  const pausedIndex = output.paused_step_index;
  if (typeof pausedIndex !== "number" || pausedIndex < 0) {
    return { error: "运行缺少暂停位置。" };
  }

  const { data: workflow } = await ctx.supabase
    .from("workflows")
    .select("definition")
    .eq("id", workflowIdParsed.data)
    .maybeSingle();
  if (!workflow) return { error: "工作流不存在。" };
  let definition;
  try {
    definition = parseDefinition(workflow.definition);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "步骤定义无效。" };
  }

  // 提交的输入写入 run.output.pending_input,续跑时拼进步骤指令
  await ctx.supabase
    .from("workflow_runs")
    .update({ status: "RUNNING", output: { ...output, pending_input: inputTrimmed } })
    .eq("id", runIdParsed.data);
  await ctx.supabase
    .from("workflows")
    .update({ status: "RUNNING", updated_at: new Date().toISOString() })
    .eq("id", workflowIdParsed.data);

  const cookieHeader = (await cookies()).toString();
  // 同 approveWorkflowStep:从 pausedIndex 恢复,被闸门保护的步骤携带
  // 用户输入真正执行一次,而不是被跳过。
  const result = await executeWorkflowSteps(
    {
      supabase: ctx.supabase as never,
      organizationId: ctx.organization.id,
      userId: ctx.user.id,
    },
    workflowIdParsed.data,
    runIdParsed.data,
    definition,
    pausedIndex,
    cookieHeader,
    pausedIndex,
  );

  revalidatePath("/workflow");
  if (result.error) return { error: result.error };
  if (result.paused) {
    return { ok: `已在「${result.pausedStepTitle ?? "未知步骤"}」前停下,等待输入/确认。` };
  }
  return { ok: result.ok ?? "完成。" };
}
