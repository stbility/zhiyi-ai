import type { NextRequest } from "next/server";

import { logger } from "@/lib/log";
import {
  errorResponse,
  preflightTurn,
  quotaExceededResponse,
} from "@/lib/ai/turn-preflight";
import type { ProviderKind } from "@/lib/providers/registry";

/**
 * 智能体通道。**多步工具循环,产物写进工作区。**
 *
 * 与 /api/chat 的根本区别不是「更强的对话」,是**有副作用**:
 * 模型能连续调用工具改变工作区,而不只是输出文本。
 * 这是「智能体」和「聊天助手」的分界线,也是这两条路由必须分开的理由 ——
 * 参照 Claude:claude.ai 那些界面默认不改你的仓库、不跑你的 shell,
 * 要动真格的得去 Claude Code。
 *
 * 此前两者共用 /api/chat,靠请求体里一个 `agent: true` 分岔,前端则靠
 * localStorage 里一个开关决定发不发这个字段。两个后果都真实发生过:
 *   · 改一条顺手动到共用代码,另一条跟着坏
 *   · 开关状态用户看不见,于是每一句话都在悄悄走智能体
 *
 * 入口检查(鉴权、限流、归属、附件、上下文、留痕)与对话通道共用同一份
 * 实现,见 lib/ai/turn-preflight.ts —— 分开的是执行形态,不是安全检查。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel 的函数最长 300 秒,调不高。这是全链路上唯一还留着的时限,
// 而且它来自平台而不是我们的判断。
// https://vercel.com/docs/functions/configuring-functions/duration
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  // 限流用 agent 这个主体单独计数。
  //
  // 智能体一轮就是十几次上游调用,和对话共用一个计数器的话,
  // 跑一次智能体会把对话额度顺带打光 —— 而用户完全不知道为什么
  // AI 助手突然说「请求过于频繁」。
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
    userMessage,
    history,
  } = pre.ctx;

  // 权益守卫:智能体是多步工具循环,消耗 monthly_agent_turns 额度。
  //
  // 挡在入口,不等到循环启动 —— 一个必然越权的任务不该被开始。
  // 免费用户跑智能体会先撞这里:明确告诉他这是套餐边界,
  // 而不是让他在「正在思考」的界面里等一个注定失败的运行。
  // 判断走数据库(get_entitlements),不信任客户端传的 plan。
  //
  // 组织 owner/admin 豁免、配额减去本月已用量、异常 fail-closed ——
  // 这三件事两条通道一字不差地都要做,所以只有一处实现:
  // lib/billing/turn-quota.ts。此前它只写在这条路由里,
  // /api/chat 一行都没有,免费用户走助手通道可以无限调用。
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
  // resumeRunId 存在时跳过权益检查 —— 续跑的是用户已经付过费的运行,
  // 订阅在运行中途到期也不该把「把已开始的任务掐断」。

  // 并发数权益(0055 concurrent_tasks):同时运行的智能体任务数按档位限制。
  //   · 用户直接发起的回合:检查 agent_runs 活跃数(queued/running/waiting_model/running_tool)
  //     + workflow_runs 活跃数,达到档位上限即拒绝 —— 承诺必须有 gating。
  //   · 续跑(resumeRunId)与工作流 Worker 步骤(x-zhiyi-worker)跳过:
  //     并发已在入口检查过(worker 在 runWorkflow 入队时检查),避免自锁。
  if (!resumeRunId && request.headers.get("x-zhiyi-worker") !== "1") {
    const { checkConcurrentTasks } = await import("@/lib/billing/concurrency");
    const concurrencyBlocked = await checkConcurrentTasks({ supabase, userId, organizationId });
    if (concurrencyBlocked.blocked) {
      return errorResponse(concurrencyBlocked.reason, 429);
    }
  }

  // 挡在入口,而不是等跑到第一步再失败。
  //
  // callWithTools 里已经有这道判断,但那时智能体循环已经启动、
  // 用户已经在等一个「正在思考」的界面 —— 一个必然失败的任务不该被开始。
  // 更要紧的是:能力边界要说清楚是能力边界,不能让用户以为是配置错了。
  const { supportsToolCalling } = await import("@/lib/ai/gateway");
  if (!supportsToolCalling(providerKind as ProviderKind)) {
    return errorResponse(
      `该服务商用的是 ${providerKind} 协议,本项目尚未为它实现工具调用适配,` +
        `所以智能体暂时用不了 —— 这不是你的配置有问题。` +
        `请改用 OpenAI 兼容接口的服务商。`,
      400,
    );
  }

  // ── Capability Gate(P0-1/P0-2)──────────────────────────────────────────
  // Task Type 能力匹配:model.capabilities ⊇ task.requirements。
  // 用 Capability Registry 单一事实来源,不在本路由另写能力判断。
  // 缺省 taskType = "text",任何模型(至少声明 text)都能过,不破坏旧行为。
  const { modelCapabilities, matchTaskCapabilities } = await import(
    "@/lib/ai/capabilities"
  );
  const taskType = pre.ctx.taskType;
  const { caps, known } = modelCapabilities(model);
  if (!known) {
    // 未知模型:不默认 AVAILABLE,但也不阻塞 text 任务 ——
    // text 是最低要求,未知模型按「可尝试」放行,留痕说明。
    logger.warn(
      { model, taskType },
      "Capability Gate: 未知模型能力,按 text 任务放行",
    );
  } else {
    const taskCheck = matchTaskCapabilities(caps, taskType);
    if (!taskCheck.compatible) {
      const missing = [...taskCheck.missing, ...taskCheck.unknown];
      return errorResponse(
        `所选模型 (${model}) 不满足任务类型「${taskType}」的能力要求:` +
          `缺少 ${missing.join(", ")}。` +
          `请在 Dashboard 选择具备该能力的模型。`,
        400,
      );
    }
  }

  const { runAgentTurn } = await import("@/lib/ai/agent-turn");
  return runAgentTurn({
    // 时间预算由**这条路由的 maxDuration** 推导,不在别处另写一个秒数。
    // 减掉的那点是留给「把记录写进库」的:平台到点直接杀进程,
    // 不留这点时间用户连发生了什么都看不到。
    // 0043 起余量加大到 30s:工具执行也被预算约束后,护栏在 270s 附近
    // 优雅触发,平台 300s 硬杀不会再抢先(硬杀 = 连接断开、只报断网)。
    budgetMs: maxDuration * 1000 - 30_000,
    supabase,
    userId,
    organizationId,
    conversationId,
    providerId,
    model,
    taskType,
    userMessage,
    history,
    signal: request.signal,
    ...(resumeRunId ? { resumeRunId } : {}),
  });
}
