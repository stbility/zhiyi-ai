import type { NextRequest } from "next/server";

import { errorResponse, preflightTurn } from "@/lib/ai/turn-preflight";
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
  if (!resumeRunId) {
    const { getMyEntitlements, quotaOf } = await import(
      "@/lib/billing/entitlements"
    );
    const entitlements = await getMyEntitlements();
    // quota null = 不限额度(enterprise);0 = 本月额度已耗尽;其余 = 还有余量
    const turnsQuota = entitlements ? quotaOf(entitlements, "monthly_agent_turns") : 0;
    const blocked =
      !entitlements || (turnsQuota !== null && turnsQuota <= 0);
    if (blocked) {
      return errorResponse(
        entitlements
          ? `本月的智能体运行额度已用完,升级 Professional(月付 HK$49)可提升额度。`
          : `智能体运行需要 Professional 及以上套餐(月付 HK$49)。` +
              `升级后即可使用多步工具循环;或改用「AI 助手」对话通道。`,
        402,
      );
    }
  }
  // resumeRunId 存在时跳过权益检查 —— 续跑的是用户已经付过费的运行,
  // 订阅在运行中途到期也不该把「把已开始的任务掐断」。

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

  const { runAgentTurn } = await import("@/lib/ai/agent-turn");
  return runAgentTurn({
    // 时间预算由**这条路由的 maxDuration** 推导,不在别处另写一个秒数。
    // 减掉的那点是留给「把记录写进库」的:平台到点直接杀进程,
    // 不留这点时间用户连发生了什么都看不到。
    budgetMs: maxDuration * 1000 - 15_000,
    supabase,
    userId,
    organizationId,
    conversationId,
    providerId,
    model,
    userMessage,
    history,
    signal: request.signal,
    ...(resumeRunId ? { resumeRunId } : {}),
  });
}
