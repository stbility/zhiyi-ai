import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentStep } from "@/lib/ai/agent";
import { logger } from "@/lib/log";

/**
 * 智能体运行的检查点。
 *
 * 【要解决的真实故障】
 * 用户实测:智能体成功执行了 git_list_files、读回了目录,然后请求在
 * 102 秒时超时中断 —— **读到的目录直接消失,连"发生过"都没有痕迹**。
 *
 * 根因不是工具坏了,是执行模型:
 *   · 工具结果只累积在浏览器的 React state 里
 *   · 落库只发生在 runAgent() **完整返回之后**
 *   · 失败路径只写一条空消息
 *
 * 整轮工作要么全保住、要么全丢掉。而模型越慢、任务越长,越容易撞上
 * 300 秒平台上限 —— **越有价值的长任务越容易全丢**。
 *
 * 【写入顺序是硬要求】
 *   执行工具 → 写 agent_steps → 提交 → 发 SSE → 下一轮模型调用
 *
 * 反过来的话,用户在界面上看到了这一步、而请求恰好在落库前被杀,
 * 他看见过的东西数据库里没有,刷新之后凭空消失 —— 那比没显示更糟。
 *
 * 【落库失败不中断运行】
 * 这里的每一处失败都只记 warn。检查点是**为了少丢**,不是为了多一个
 * 让整轮崩掉的理由 —— 写不进去的时候,让智能体接着干完仍然是更好的结果。
 * 但失败必须留痕:静默吞掉的话,「为什么恢复不了」会变成查不出原因的现象。
 */

export interface RunJournal {
  readonly runId: string;
  /** 一步完成时调用。**返回的 Promise 必须被 await** */
  record(step: AgentStep): Promise<void>;
  /** 收尾。中断路径也要调 —— 状态停在 running 就没人知道它是死是活 */
  finish(
    outcome: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string,
  ): Promise<void>;
}

/** 单步结果只存摘要。全文可能几万字符,而恢复上下文时本来就要截断 */
const PREVIEW_CHARS = 2_000;

export async function openRunJournal(
  supabase: SupabaseClient,
  input: {
    conversationId: string;
    organizationId: string;
    providerId: string | null;
    modelId: string;
  },
): Promise<RunJournal | null> {
  const { data, error } = await supabase
    .from("agent_runs")
    .insert({
      conversation_id: input.conversationId,
      organization_id: input.organizationId,
      // 平台免费档在 ai_providers 里没有行,provider_id 只能留空
      provider_id: input.providerId,
      model_id: input.modelId,
      status: "running",
    })
    .select("id")
    .single();

  if (error || !data) {
    logger.warn(
      { conversationId: input.conversationId, dbError: error?.message },
      "无法创建智能体运行记录,本轮不做检查点",
    );
    return null;
  }

  const runId = data.id as string;

  return {
    runId,

    async record(step: AgentStep) {
      // 一步可能调多个工具。一个工具一行 —— 恢复时要按工具粒度判断
      // 「这次调用做过没有」,按步粒度判断不够:同一步里前两个工具做完、
      // 第三个被杀掉,按步算会把前两个也当成没做。
      const rows = step.tools.map((t, i) => ({
        run_id: runId,
        // 同一步内多个工具用小数位区分,保持全局单调
        step_index: step.index * 100 + i,
        tool_call_id: t.callId,
        tool_name: t.name,
        // 入参里有「哪个仓库、哪个路径」。不记的话,事后只能从结果
        // 正文里猜读了什么 —— 而失败的调用连正文都没有
        arguments: (t.args ?? null) as never,
        result_preview: t.content.slice(0, PREVIEW_CHARS),
        // **记事实,不是记我们展示了什么。**
        // 摘要 300 字这件事,既不能证明读成功了也不能证明没读成功;
        // 原文多长才能。用户就是因为看不到这个数,
        // 把 300 字的摘要误认成「读取中断」。
        result_chars: t.content.length,
        preview_chars: Math.min(t.content.length, PREVIEW_CHARS),
        truncated: t.content.length > PREVIEW_CHARS,
        duration_ms: t.durationMs ?? null,
        ok: t.ok,
        completed_at: new Date().toISOString(),
      }));

      // 模型只说话没调工具的那一步也要留一行 —— 否则恢复时会漏掉
      // 它说过的内容,重放出来的上下文与原来不一致
      if (rows.length === 0) {
        rows.push({
          run_id: runId,
          step_index: step.index * 100,
          tool_call_id: null as unknown as string,
          tool_name: null as unknown as string,
          arguments: null as never,
          result_preview: step.text.slice(0, PREVIEW_CHARS),
          result_chars: step.text.length,
          preview_chars: Math.min(step.text.length, PREVIEW_CHARS),
          truncated: step.text.length > PREVIEW_CHARS,
          duration_ms: null,
          ok: true,
          completed_at: new Date().toISOString(),
        });
      }

      const { error: stepError } = await supabase
        .from("agent_steps")
        .insert(rows);
      if (stepError) {
        logger.warn(
          { runId, step: step.index, dbError: stepError.message },
          "智能体步骤未能落库,这一步在中断后无法恢复",
        );
      }

      // 进度单独更新。它是恢复的起点,比步骤明细更要紧 ——
      // 明细写失败还能从 messages 里勉强重建,进度丢了就不知道从哪续
      const { error: runError } = await supabase
        .from("agent_runs")
        .update({ current_step: step.index, status: "running" })
        .eq("id", runId);
      if (runError) {
        logger.warn(
          { runId, dbError: runError.message },
          "智能体运行进度未能更新",
        );
      }
    },

    async finish(outcome, errorMessage) {
      const { error } = await supabase
        .from("agent_runs")
        .update({
          status: outcome,
          completed_at: new Date().toISOString(),
          error_message: errorMessage ?? null,
          // 跑完的不需要续;被中断的才需要
          resumable: outcome === "interrupted",
        })
        .eq("id", runId);

      if (error) {
        logger.warn(
          { runId, outcome, dbError: error.message },
          "智能体运行状态未能收尾,记录会一直停在 running",
        );
        return;
      }

      // 【Bug 4 修复】用量计量:统计本轮 agent_turns 写入 usage_metering
      // agent_runs 表没有 user_id,通过 conversations 查到
      const { data: conv } = await supabase
        .from("conversations")
        .select("user_id")
        .eq("id", input.conversationId)
        .single();

      if (!conv?.user_id) {
        logger.warn({ runId, conversationId: input.conversationId }, "finish: 找不到 conversation 的 user_id,跳过用量记录");
        return;
      }

      // agent_steps 表的 step_index 是 step*100+tool_index,最大步数 = Math.ceil(max_index/100)
      const { data: stepRow } = await supabase
        .from("agent_steps")
        .select("step_index")
        .eq("run_id", runId)
        .order("step_index", { ascending: false })
        .limit(1)
        .single();

      const stepCount = stepRow ? Math.ceil(Number(stepRow.step_index) / 100) : 0;
      const units = Math.max(1, stepCount);

      // bump_usage 失败不阻断:计量漏记比整轮失败危害小
      await supabase.rpc("bump_usage", {
        p_user_id: conv.user_id,
        p_category: "agent_turns",
        p_units: units,
      }).then(({ error: rpcErr }) => {
        if (rpcErr) {
          logger.warn({ runId, userId: conv.user_id, units, rpcErr: rpcErr.message },
            "finish: bump_usage 失败,用量未记录");
        }
      });
    },
  };
}
