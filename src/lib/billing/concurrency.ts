import { getMyEntitlements, quotaOf } from "@/lib/billing/entitlements";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 并发任务数权益(0055 concurrent_tasks)检查。
 *
 * 语义:同时运行的智能体回合 + 工作流运行,按档位限制:
 *   free=1 / professional=2 / professional_plus=5 / team·enterprise=null(不限)。
 *
 * 纪律与 turn-quota 一致:get_entitlements 失败按 0(拦截)处理,
 * 异常不等于放行。agent 入口与 workflow 入队共用这一份实现。
 */

const ACTIVE_AGENT_STATUSES = ["queued", "running", "waiting_model", "running_tool"];

export async function checkConcurrentTasks(params: {
  supabase: SupabaseClient;
  userId: string;
  organizationId: string;
}): Promise<{ blocked: true; reason: string } | { blocked: false }> {
  const { supabase, organizationId } = params;

  const entitlements = await getMyEntitlements();
  const quota = entitlements ? quotaOf(entitlements, "concurrent_tasks") : 0;
  if (quota === null) return { blocked: false }; // 不限(Team/Enterprise)
  if (quota <= 0) {
    return { blocked: true, reason: "当前套餐不支持并发执行任务。" };
  }

  // 活跃智能体回合
  const { count: agentCount, error: agentErr } = await supabase
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("status", ACTIVE_AGENT_STATUSES);
  if (agentErr) {
    return { blocked: true, reason: "并发检查失败,请稍后重试。" };
  }

  // 活跃工作流运行(workflow_runs 无 organization_id,先取组织 workflow ids)
  const { data: wfIds, error: wfErr } = await supabase
    .from("workflows")
    .select("id")
    .eq("organization_id", organizationId);
  if (wfErr) {
    return { blocked: true, reason: "并发检查失败,请稍后重试。" };
  }
  const { count: workflowCount, error: workflowErr } = await supabase
    .from("workflow_runs")
    .select("id", { count: "exact", head: true })
    .eq("status", "RUNNING")
    .in("workflow_id", (wfIds ?? []).map((r) => r.id as string));
  if (workflowErr) {
    return { blocked: true, reason: "并发检查失败,请稍后重试。" };
  }

  const active = (agentCount ?? 0) + (workflowCount ?? 0);
  if (active >= quota) {
    return {
      blocked: true,
      reason: `同时运行的任务数已达套餐上限(${quota} 个),请等当前任务结束后再试。`,
    };
  }
  return { blocked: false };
}
