import "server-only";

import { ProviderCallError, callWithTools } from "@/lib/ai/gateway";
import { isTransientFailure } from "@/lib/providers/model-filter";
import type { ProviderCredentials } from "@/lib/ai/gateway";
import {
  AGENT_SYSTEM_PROMPT,
  FILE_TOOLS,
  executeTool,
  type ToolContext,
  type ToolResult,
} from "@/lib/ai/tools";

/**
 * 智能体运行循环。
 *
 * 与一问一答的区别:模型可以连续请求工具、观察结果、再决定下一步,
 * 直到它认为任务完成。这才是「智能体」——能做,而不只是能说。
 *
 * 护栏是这里最重要的部分,比功能本身更重要:
 * 一个没有上限的循环就是一台烧钱机器,模型完全可能在两个工具之间反复横跳。
 * 所以步数、时间、失败次数都必须有硬上限,而且到达上限时如实说明,
 * 不假装任务完成了。
 */

export interface AgentStep {
  /** 第几步,从 1 开始 */
  readonly index: number;
  /** 模型这一步说的话 */
  readonly text: string;
  /** 这一步执行的工具 */
  readonly tools: readonly ToolResult[];
}

export interface AgentOutcome {
  /** 最终给用户看的回答 */
  readonly answer: string;
  readonly steps: readonly AgentStep[];
  /** 累计用量 */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 因为撞上护栏而中止时的说明。正常结束为 null */
  readonly haltReason: string | null;
  /** 运行中降级用过的备用模型。悄悄换模型等于伪造来源,必须告知 */
  readonly usedModels: readonly string[];
}

export interface AgentLimits {
  /** 最多几步 —— 防止模型在工具之间反复横跳 */
  readonly maxSteps: number;
  /** 总时间预算(毫秒),必须留在平台函数时限之内 */
  readonly budgetMs: number;
  /** 连续失败多少次就停 —— 一直失败说明它没在改正,再试也是浪费 */
  readonly maxConsecutiveFailures: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxSteps: 12,
  budgetMs: 240_000,
  maxConsecutiveFailures: 3,
};

/** 循环过程中的进度回调,用于把每一步实时推给前端 */
export interface AgentReporter {
  onStep?(step: AgentStep): void;
}

/**
 * 跑一次智能体循环。
 *
 * @param userMessage 本轮用户的要求(已含项目文件与检索材料等上下文)
 * @param history 之前的对话,按时间正序
 */
export async function runAgent({
  credentials,
  model,
  fallbackModels = [],
  userMessage,
  history,
  toolContext,
  signal,
  limits = DEFAULT_LIMITS,
  reporter,
}: {
  credentials: ProviderCredentials;
  model: string;
  /**
   * 备用模型,按优先级排列。
   *
   * 智能体一跑就是十几步,中途撞上限流或排队是常态。没有备用模型的话,
   * 第 11 步一个 503 就把前 10 步的工作全打死 —— 而那些文件其实已经写好了。
   * 普通对话早有跨厂商降级,智能体循环当初漏接了,这里补上。
   */
  fallbackModels?: readonly string[];
  userMessage: string;
  history: readonly { role: "user" | "assistant"; content: string }[];
  toolContext: ToolContext;
  signal: AbortSignal;
  limits?: AgentLimits;
  reporter?: AgentReporter;
}): Promise<AgentOutcome> {
  const startedAt = Date.now();

  // 对话消息数组会在循环里不断追加(助手的工具请求 + 工具结果),
  // 所以用宽松类型 —— tool 角色不在 ChatMessage 的三种之内。
  const messages: Record<string, unknown>[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  const steps: AgentStep[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let consecutiveFailures = 0;
  let answer = "";
  let haltReason: string | null = null;
  /** 当前实际在用的模型,降级后会变 */
  let activeModel = model;
  /** 本次运行中用过的备用模型 —— 换过模型必须告诉用户,不能悄悄换 */
  const switchedModels = new Set<string>();

  for (let index = 1; index <= limits.maxSteps; index++) {
    if (Date.now() - startedAt > limits.budgetMs) {
      haltReason =
        `已达到本次运行的时间上限(${Math.round(limits.budgetMs / 1000)} 秒),` +
        `在第 ${index - 1} 步停止。已完成的文件都已保存在工作区,可以继续追问未完成的部分。`;
      break;
    }

    // 这一步依次尝试主模型与备用模型。
    //
    // 只对**临时性**失败换模型(限流、排队、5xx);密钥错误、模型不存在
    // 这类换几次都一样,换了只是白白多烧几次配额。
    let turn;
    let lastError: ProviderCallError | null = null;
    for (const candidate of [model, ...fallbackModels]) {
      try {
        turn = await callWithTools({
          credentials,
          model: candidate,
          messages,
          tools: FILE_TOOLS,
          signal,
        });
        if (candidate !== activeModel) {
          activeModel = candidate;
          switchedModels.add(candidate);
        }
        lastError = null;
        break;
      } catch (e) {
        const err =
          e instanceof ProviderCallError
            ? e
            : new ProviderCallError("调用模型服务失败。");
        lastError = err;
        if (!isTransientFailure(err.status, err.message)) break;
      }
    }

    if (!turn) {
      // 全都试过还是不行。已完成的步骤不能白费 —— 文件早就写进工作区了,
      // 所以这里不抛错,而是带着已有成果如实收尾。
      haltReason =
        steps.length > 0
          ? `第 ${index} 步调用模型失败,已停止:${lastError?.message ?? "未知原因"}\n` +
            `前 ${steps.length} 步已完成,产出的文件都在工作区里。`
          : (lastError?.message ?? "调用模型服务失败。");
      if (steps.length === 0 && lastError) throw lastError;
      break;
    }

    inputTokens += turn.usage.inputTokens ?? 0;
    outputTokens += turn.usage.outputTokens ?? 0;

    // 没有工具调用 = 模型认为任务完成了
    if (turn.toolCalls.length === 0) {
      answer = turn.text;
      if (turn.text.trim() === "") {
        // 既不调工具也不说话 —— 这是异常,如实说明而不是给个空气泡
        haltReason =
          "模型既没有调用工具也没有给出回答。可能是该模型不支持工具调用," +
          "或本轮被内容策略拦截。可换一个模型重试。";
      }
      steps.push({ index, text: turn.text, tools: [] });
      reporter?.onStep?.({ index, text: turn.text, tools: [] });
      break;
    }

    // 把模型的工具请求原样放回消息里 —— 协议要求下一轮能对上 tool_call_id
    messages.push({
      role: "assistant",
      content: turn.text === "" ? null : turn.text,
      tool_calls: turn.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.rawArguments },
      })),
    });

    const results: ToolResult[] = [];
    for (const call of turn.toolCalls) {
      const result = await executeTool(call, toolContext);
      results.push(result);
      messages.push({
        role: "tool",
        tool_call_id: result.callId,
        content: result.content,
      });
    }

    const step: AgentStep = { index, text: turn.text, tools: results };
    steps.push(step);
    reporter?.onStep?.(step);

    // 连续失败说明模型没在改正,再循环只是浪费配额
    const allFailed = results.every((r) => !r.ok);
    consecutiveFailures = allFailed ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= limits.maxConsecutiveFailures) {
      haltReason =
        `工具连续 ${consecutiveFailures} 次执行失败,已停止。` +
        `最后一次的原因:${results[results.length - 1]?.content ?? "未知"}`;
      break;
    }

    if (index === limits.maxSteps) {
      haltReason =
        `已达到本次运行的步数上限(${limits.maxSteps} 步)。` +
        `已完成的文件都已保存在工作区,可以继续追问未完成的部分。`;
    }
  }

  return {
    answer,
    steps,
    inputTokens,
    outputTokens,
    haltReason,
    usedModels: [...switchedModels],
  };
}

/**
 * 把一次运行总结成给用户看的文字。
 *
 * 用户关心的是「做了什么」,不是每一步的原始输出。文件内容在工作区里,
 * 这里只列清单 —— 把文件内容再贴一遍正是我们要消灭的行为。
 */
export function summarizeRun(outcome: AgentOutcome): string {
  const written = new Set<string>();
  const read = new Set<string>();

  for (const step of outcome.steps) {
    for (const t of step.tools) {
      if (!t.ok) continue;
      if (t.name === "write_file") {
        // 工具结果文案形如「已写入 src/app.ts(123 字符)。」
        const m = /^已写入\s+(\S+?)(?:[(（]|$)/.exec(t.content);
        if (m?.[1]) written.add(m[1]);
      } else if (t.name === "read_file") {
        read.add(t.name);
      }
    }
  }

  const parts: string[] = [];
  if (written.size > 0) {
    parts.push(
      `本次共写入 ${written.size} 个文件:\n` +
        [...written].map((p) => `· ${p}`).join("\n"),
    );
  }
  if (outcome.answer.trim() !== "") parts.push(outcome.answer.trim());
  if (outcome.usedModels.length > 0) {
    parts.push(
      `运行中主模型不可用,已自动改用:${outcome.usedModels.join("、")}。`,
    );
  }
  if (outcome.haltReason) parts.push(outcome.haltReason);

  return parts.length === 0
    ? "本次运行没有产生任何输出。"
    : parts.join("\n\n");
}
