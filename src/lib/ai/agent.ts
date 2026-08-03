import "server-only";

import { ProviderCallError, callWithTools } from "@/lib/ai/gateway";
import { isTransientFailure } from "@/lib/providers/model-filter";
import type { ProviderCredentials } from "@/lib/ai/gateway";
import { GIT_TOOLS, executeGitTool, type GitToolContext } from "@/lib/ai/git-tools";
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
  /**
   * 单步等待上限(毫秒)。
   *
   * budgetMs 只在每步**开始前**判断,拦不住一个已经挂住的调用 ——
   * 而智能体的每一步都是一次非流式请求,上游不回就一个字节都没有。
   * 没有这一项时,服务商容量塌陷会让一步挂满整个函数时限,
   * 最后被平台强杀、连接断开,浏览器只报「Failed to fetch」。
   *
   * 取 120 秒:正常模型写完一个文件远用不到,而慢到这个程度的
   * 服务商本来就该被换掉。实际生效值还会被剩余预算进一步收窄。
   */
  readonly stepTimeoutMs: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxSteps: 12,
  budgetMs: 240_000,
  maxConsecutiveFailures: 3,
  stepTimeoutMs: 120_000,
};

/**
 * 单条工具结果回喂给模型的字符上限。
 *
 * 工具结果会被原样追加进 messages,而 messages 每一步都要整个重发。
 * read_file / git_read_file 读一个 100KB 的文件,之后每一步都要再背一遍 ——
 * 12 步下来光这一个文件就重复传了十几次,既撑爆上下文也把钱烧光。
 *
 * 截断必须**让模型看见**:悄悄截断会让它以为读到的就是文件全文,
 * 据此改出来的代码是错的,比读不到更糟。
 */
export const MAX_TOOL_RESULT_CHARS = 30_000;

/** 按上限截断工具结果,并如实告诉模型被截断了 */
export function capToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  return (
    content.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n\n…[内容过长,此处截断。原文共 ${content.length} 个字符,` +
    `已显示前 ${MAX_TOOL_RESULT_CHARS} 个。需要后面的部分请按目录或分段再读。]`
  );
}

/**
 * 一个可用的「服务商 + 模型」组合。
 *
 * 智能体的降级必须带上凭据一起换:此前只换模型名、凭据固定是用户选的
 * 那一家,于是所谓的降级永远出不了那个服务商 —— 而服务商的容量塌陷
 * 是整体性的,同一家里换几个模型等于没换。见 lib/ai/candidates.ts。
 */
export interface AgentModelOption {
  readonly providerId: string;
  /** 服务商显示名,用于向用户如实说明换到了哪一家 */
  readonly providerName: string;
  readonly modelId: string;
  readonly credentials: ProviderCredentials;
}

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
  candidates,
  userMessage,
  history,
  toolContext,
  gitContext,
  signal,
  limits = DEFAULT_LIMITS,
  reporter,
}: {
  /**
   * 候选「服务商 + 模型」,按优先级排列,第一个是用户选的那个。
   *
   * 智能体一跑就是十几步,中途撞上限流或排队是常态。没有备用的话,
   * 第 11 步一个 503 就把前 10 步的工作全打死 —— 而那些文件其实已经写好了。
   *
   * 关键是候选要**跨服务商**。此前只换模型名、凭据固定用第一家的,
   * 于是英伟达容量塌陷时三个候选全在英伟达,全部超时,而用户配好的
   * DeepSeek 官方一次都没被试过 —— 这正是「智能体不工作」的根因。
   */
  candidates: readonly AgentModelOption[];
  userMessage: string;
  history: readonly { role: "user" | "assistant"; content: string }[];
  toolContext: ToolContext;
  /**
   * Git 仓库工具的上下文。未连接仓库时为 undefined ——
   * 那种情况下**根本不把这几个工具交给模型**,而不是给了再拒绝。
   * 给一个必然失败的工具,模型会反复尝试并把步数耗光。
   */
  gitContext?: GitToolContext | undefined;
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
  const primary = candidates[0];
  if (!primary) {
    throw new ProviderCallError(
      "没有可用的模型。请到「模型服务」添加服务商并测试连接。",
    );
  }
  /** 当前实际在用的「服务商 + 模型」,降级后会变 */
  let active: AgentModelOption = primary;
  /** 本次运行中换用过的候选 —— 换过必须告诉用户,悄悄换等于伪造来源 */
  const switchedModels = new Set<string>();
  /** 已确认整体不可用的服务商(密钥失效等),同一家的其余候选直接跳过 */
  const deadProviders = new Set<string>();

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
    // 从**当前生效的模型**开始,不是从用户最初选的那个开始。
    //
    // 原来写的是 [model, ...fallbackModels]:第 1 步降级到 B 之后,
    // 第 2 步到第 12 步每一步都要先撞一次已知在排队的 A,白白多等一轮。
    // 更糟的是下面那句 candidate !== activeModel 会因此成立,
    // 于是把用户自己选的 A 记进「换过的模型」,最后报告
    // 「运行中主模型不可用,已自动改用:A」—— A 正是他选的那个。
    const current = active;
    const order: readonly AgentModelOption[] = [
      current,
      ...candidates.filter(
        (c) => !(c.providerId === current.providerId && c.modelId === current.modelId),
      ),
    ];
    for (const candidate of order) {
      // 这家已经确认不可用(密钥失效等),同一把密钥换个模型结果一样
      if (deadProviders.has(candidate.providerId)) continue;

      // 单步超时按**剩余预算**收窄,而不是每个候选各给一份 120 秒 ——
      // 否则三个候选轮下来就是 360 秒,早就撞破总预算和平台时限了。
      const remaining = limits.budgetMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      const stepTimeout = Math.min(limits.stepTimeoutMs, remaining);

      try {
        turn = await callWithTools({
          // 每个候选用**它自己服务商**的密钥 —— 拿 A 家的 key 调 B 家的模型
          // 只会得到 401,跨服务商降级的前提就是凭据也跟着换
          credentials: candidate.credentials,
          model: candidate.modelId,
          messages,
          tools: gitContext ? [...FILE_TOOLS, ...GIT_TOOLS] : FILE_TOOLS,
          signal,
          timeoutMs: stepTimeout,
        });
        if (
          candidate.providerId !== current.providerId ||
          candidate.modelId !== current.modelId
        ) {
          active = candidate;
          switchedModels.add(`${candidate.providerName} · ${candidate.modelId}`);
        }
        lastError = null;
        break;
      } catch (e) {
        const err =
          e instanceof ProviderCallError
            ? e
            : new ProviderCallError("调用模型服务失败。");
        lastError = err;
        // 永久性失败:整家跳过,但继续试**别的**服务商。
        // 此前是 break 掉整轮 —— 那在「候选全在同一家」的年代是对的,
        // 现在候选跨服务商,一把过期密钥不该把整个组织的能力堵死。
        if (!isTransientFailure(err.status, err.message)) {
          deadProviders.add(candidate.providerId);
        }
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

    // 被输出长度上限截断了。
    //
    // 这时工具调用的参数是**残缺的 JSON**,执行必然得到「参数不是合法的
    // JSON」;而模型再试一次仍然会写到同样的长度、同样被截断,于是剩下的
    // 步数就在这个循环里烧光,用户等到最后拿到一句不知所云的报错。
    // finishReason 这个字段一直取回来了却从没被用过,这里正是它该用的地方。
    if (turn.finishReason === "length") {
      answer = turn.text;
      haltReason =
        `模型这一步的输出被长度上限截断了` +
        (turn.toolCalls.length > 0
          ? `,工具调用的参数不完整,无法安全执行 —— 强行执行会写出半截文件。`
          : `。`) +
        `请把任务拆小一些再试(例如一次只让它写一个文件),` +
        `或换一个输出长度上限更高的模型。`;
      steps.push({ index, text: turn.text, tools: [] });
      reporter?.onStep?.({ index, text: turn.text, tools: [] });
      break;
    }

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
      // 按工具名分派:Git 工具走仓库,其余走工作区。
      // 两套工具的失败语义一致 —— 都返回观察结果而不抛错。
      const result = call.name.startsWith("git_")
        ? gitContext
          ? await executeGitTool(call, gitContext)
          : {
              callId: call.id,
              name: call.name,
              ok: false,
              content:
                "尚未连接 Git 仓库,无法使用仓库工具。请先到「集成」页连接 GitHub。",
            }
        : await executeTool(call, toolContext);
      results.push(result);
      messages.push({
        role: "tool",
        tool_call_id: result.callId,
        // 回喂给模型的那份按上限截断,给用户看的 results 保留完整内容。
        //
        // messages 每一步都要整个重发,而 read_file 可能读回一个 100KB 的
        // 文件 —— 不截断的话 12 步下来同一个文件被重复传十几次,
        // 上下文撑爆、钱也烧光。截断处会明确告诉模型「这里截断了」。
        content: capToolResult(result.content),
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
