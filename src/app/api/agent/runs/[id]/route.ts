import type { NextRequest } from "next/server";

import { errorResponse } from "@/lib/ai/turn-preflight";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 只读查询,不需要长时执行
export const maxDuration = 30;

/**
 * Agent 异步任务状态查询(阶段 G 补充,只读)。
 *
 * 【职责】返回单个 run 的实时状态:
 *   status / current_step / error_message / resumable
 *   + 该 run 的 agent_steps(工具步骤,按 step_index 升序)
 *
 * 【鉴权】复用系统原生 RLS(agent_runs_own / agent_steps_own,
 *   0027 迁移:conversations.user_id = auth.uid()):
 *   - 登录:supabase.auth.getUser()(401)
 *   - 隔离:supabase 客户端查询,RLS 自动拒绝非本人 run(404 语义)
 *   不手动按 organization_id 过滤 —— 那会绕过 RLS 单点,与全站模型不一致。
 *
 * 【冻结边界】只读查询,零写操作;不动 Runner / 状态机 / 同步链路。
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const runId = (await params).id;
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) {
    return errorResponse("运行标识无效", 400);
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return errorResponse("认证服务未配置。", 503);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return errorResponse("登录状态已失效,请重新登录。", 401);
  }

  // 1) run 主状态 —— RLS 自动限定本人可见(跨用户/跨组织 = 查无此行)
  const { data: run, error: runErr } = await supabase
    .from("agent_runs")
    .select(
      "id, status, current_step, error_message, resumable, model_id, task_type, started_at, updated_at, completed_at",
    )
    .eq("id", runId)
    .maybeSingle();

  // RLS 拒绝或不存在:统一 404,不泄露 run 是否存在(防枚举)
  if (runErr || !run) {
    return errorResponse("运行不存在", 404);
  }

  // 2) 工具步骤(实时进展)—— RLS(agent_steps_own)同样自动隔离
  const { data: steps } = await supabase
    .from("agent_steps")
    .select(
      "step_index, tool_name, ok, result_preview, started_at, completed_at",
    )
    .eq("run_id", runId)
    .order("step_index", { ascending: true });

  return Response.json({
    runId: run.id,
    status: run.status,
    currentStep: run.current_step,
    error: run.error_message,
    resumable: run.resumable,
    modelId: run.model_id,
    taskType: run.task_type,
    startedAt: run.started_at,
    updatedAt: run.updated_at,
    completedAt: run.completed_at,
    steps: (steps ?? []).map((s) => ({
      index: s.step_index,
      tool: s.tool_name,
      ok: s.ok,
      preview: s.result_preview,
      startedAt: s.started_at,
      completedAt: s.completed_at,
    })),
  });
}
