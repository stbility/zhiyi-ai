import type { NextRequest } from "next/server";

import { logger } from "@/lib/log";
import { errorResponse, preflightTurn, quotaExceededResponse } from "@/lib/ai/turn-preflight";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isPlatformProviderId } from "@/lib/ai/platform-models";

/**
 * 智能体长任务异步入口(阶段 G)。
 *
 * 【feature flag】AGENT_ASYNC_ENABLED 未设为 "1" 时,本端点 404(不暴露)。
 * 长任务入口默认关闭 —— Runner E2E 全部验收通过前,不得打开。
 *
 * 【职责】创建 agent_runs(queued)→ 返回 { runId }。不执行 Agent。
 * 执行由独立持久 Runner 承担(Hermes ACP,脱离 Vercel 300s 生命周期)。
 *
 * 【冻结边界】/api/agent 同步链路零改动;本端点独立,不影响同步路径。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 本端点只创建 run + 返回,不做长时执行 —— 不需要 300s 上限
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  // Feature flag:默认 OFF
  if (process.env.AGENT_ASYNC_ENABLED !== "1") {
    return new Response("Agent async 入口未启用", { status: 404 });
  }

  // 与同步链路共用同一份入口检查(鉴权/限流/权益/并发)
  const pre = await preflightTurn(request, "agent");
  if (!pre.ok) return pre.response;
  const {
    supabase,
    userId,
    organizationId,
    conversationId,
    providerId,
    providerKind,
    model,
    resumeRunId,
  } = pre.ctx;

  // 权益守卫(与同步链路一致):额度不足拒绝,resume 跳过
  if (!resumeRunId) {
    const { checkTurnQuota } = await import("@/lib/billing/turn-quota");
    const blocked = await checkTurnQuota({
      supabase,
      userId,
      organizationId,
      channel: "agent",
    });
    if (blocked) {
      return quotaExceededResponse(blocked.reason);
    }
  }

  // 并发数权益(与同步链路一致)
  if (!resumeRunId && request.headers.get("x-zhiyi-worker") !== "1") {
    const { checkConcurrentTasks } = await import("@/lib/billing/concurrency");
    const concurrencyBlocked = await checkConcurrentTasks({ supabase, userId, organizationId });
    if (concurrencyBlocked.blocked) {
      return errorResponse(concurrencyBlocked.reason, 429);
    }
  }

  // 创建 queued run(service role 直写,带完整上下文供 Runner 执行)
  const admin = createSupabaseAdminClient();
  if (!admin) {
    logger.error({ userId }, "agent async: service role 未配置");
    return errorResponse("服务配置错误", 500);
  }
  const { data: run, error } = await admin
    .from("agent_runs")
    .insert({
      conversation_id: conversationId,
      organization_id: organizationId,
      // 平台免费档 provider_id 非 UUID(platform:openai_compatible:…),
      // agent_runs.provider_id 是 uuid FK(0027),与同步路径同语义传 null。
      provider_id: isPlatformProviderId(providerId) ? null : providerId,
      model_id: model,
      status: "queued",
      current_step: 0,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      resumable: false,
      task_type: "agent",
    })
    .select("id")
    .single();

  if (error || !run) {
    logger.error({ error, userId, conversationId }, "agent async: 创建 run 失败");
    return errorResponse("创建运行失败", 500);
  }

  logger.info(
    { runId: run.id, userId, conversationId, providerId, providerKind, model },
    "agent async: run 已入队,等待 Runner 执行",
  );

  return Response.json({ runId: run.id, status: "queued" });
}
