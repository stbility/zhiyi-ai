"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getMyOrganizations } from "@/lib/db/queries";
import { getMyEntitlements, quotaOf } from "@/lib/billing/entitlements";
import { getSiteUrl } from "@/lib/env/server";
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
  const quota = entitlements ? quotaOf(entitlements, "workflows") : null;
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

/** 把 /api/agent 的 SSE 流组装成最终输出文本 */
async function readAgentStream(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return (await res.text()).slice(0, 2000);
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let output = "";
  let streamError: string | null = null;

  const handleData = (data: string) => {
    if (eventName === "delta") {
      try {
        const parsed = JSON.parse(data) as unknown;
        if (typeof parsed === "string") output += parsed;
        else if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { text?: unknown }).text === "string"
        ) {
          output += (parsed as { text: string }).text;
        }
      } catch {
        output += data;
      }
    } else if (eventName === "error") {
      try {
        const parsed = JSON.parse(data) as { message?: unknown };
        streamError = typeof parsed.message === "string" ? parsed.message : "步骤执行失败";
      } catch {
        streamError = "步骤执行失败";
      }
    }
    eventName = "";
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) handleData(line.slice(5).trim());
      }
    }
  }
  if (streamError) throw new Error(streamError);
  return output.trim();
}

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

  let definition;
  try {
    definition = parseDefinition(workflow.definition);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "步骤定义无效。" };
  }
  // READY/FAILED/PAUSED → QUEUED(入队)→ RUNNING(同步执行);终态不可重跑
  try {
    assertTransition(workflow.status as WorkflowStatus, "QUEUED");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "当前状态不可运行。" };
  }

  const setStatus = async (table: "workflows" | "workflow_runs", runId: string | null, status: WorkflowStatus, extra: Record<string, unknown> = {}) => {
    const patch: Record<string, unknown> = { status, ...extra };
    if (table === "workflows") {
      await ctx.supabase.from("workflows").update(patch).eq("id", idParsed.data);
    } else if (runId) {
      await ctx.supabase.from("workflow_runs").update(patch).eq("id", runId);
    }
  };

  // 工作流置 RUNNING(QUEUED 入队 → RUNNING 同步执行),建运行记录
  await setStatus("workflows", null, "QUEUED");
  await setStatus("workflows", null, "RUNNING");
  const { data: run, error: runError } = await ctx.supabase
    .from("workflow_runs")
    .insert({ workflow_id: idParsed.data, status: "QUEUED", trigger_source: "manual" })
    .select("id")
    .single();
  if (runError || !run) {
    await setStatus("workflows", null, "FAILED");
    return { error: `无法创建运行记录:${runError?.message ?? "未知错误"}` };
  }
  const now = new Date().toISOString();
  await setStatus("workflow_runs", run.id, "RUNNING", { started_at: now });

  const cookieHeader = (await cookies()).toString();
  const stepResults: { stepId: string; title: string; output?: string; error?: string }[] = [];
  let failed = false;
  let failureMessage = "";

  for (const step of definition.steps) {
    try {
      const res = await fetch(`${getSiteUrl()}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        body: JSON.stringify({ input: step.prompt }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `步骤失败(HTTP ${res.status})`);
      }
      const output = await readAgentStream(res);
      stepResults.push({ stepId: step.id, title: step.title, output });
    } catch (e) {
      failed = true;
      failureMessage = e instanceof Error ? e.message : String(e);
      stepResults.push({ stepId: step.id, title: step.title, error: failureMessage });
      break;
    }
  }

  if (failed) {
    await setStatus("workflow_runs", run.id, "FAILED", {
      finished_at: new Date().toISOString(),
      error: failureMessage,
      output: { steps: stepResults },
    });
    await setStatus("workflows", null, "FAILED");
    revalidatePath("/workflow");
    return { error: `工作流执行失败:${failureMessage}` };
  }

  await setStatus("workflow_runs", run.id, "COMPLETED", {
    finished_at: new Date().toISOString(),
    output: { steps: stepResults },
  });
  await setStatus("workflows", null, "READY");
  revalidatePath("/workflow");
  return { ok: `已完成 ${definition.steps.length} 个步骤。` };
}
