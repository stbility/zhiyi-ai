import "server-only";

import { ProviderCallError, callWithTools } from "@/lib/ai/gateway";
import { isTransientFailure } from "@/lib/providers/model-filter";

/**
 * 服务商在拒绝 tools / tool_choice 这两个参数本身。
 *
 * 这是判定「这个模型不支持工具调用」**唯一算数的证据**。
 *
 * 反过来那种推断是错的:模型收到了工具却用散文作答,**不能**据此判它
 * 不支持 —— 它可能只是觉得这道题不需要动工具。把「没调」当成「不能调」,
 * 就会把一个其实好好的模型永久拉黑。
 *
 * 只匹配参数被拒的措辞,不匹配「模型很忙」这类。各家措辞不同,
 * 所以按语义抓关键词而不是认厂商。
 */
const TOOLS_REJECTED =
  /tool_choice|tools?\s+(is\s+)?not\s+supported|does\s+not\s+support\s+tools?|unsupported\s+(parameter|value).*tool|function\s+calling\s+(is\s+)?not|不支持.*(工具|函数调用)/i;
import { logger } from "@/lib/log";
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
  /**
   * 因为撞上护栏而中止的原因。正常结束为 null。
   *
   * **绝不拼进 answer 里**。它由调用方走**错误通道**送出(SSE 的 error
   * 事件),界面在错误位置渲染 —— 这是 Claude 的做法:系统消息和模型回复
   * 用不同的 role 分开,各走各的通道,不合并成一段文字。
   * 拼进正文,用户看到的就是「模型说的话」,而模型没说过。
   */
  readonly haltReason: string | null;
  /**
   * 这一轮观察到的工具调用能力,交给调用方落库(ai_models.supports_tools)。
   *
   *   "observed"  亲眼见过它发出 tool_calls —— 唯一算数的正面证据
   *   "rejected"  服务商明确拒绝了 tools / tool_choice 参数
   *   null        什么都没看出来。**不写库** —— 没有观察就不要留下结论,
   *               尤其不能把「这次没调工具」记成「不支持工具」。
   */
  readonly toolSupport: "observed" | "rejected" | null;
}

export interface AgentLimits {
  /**
   * 最多几步。
   *
   * **3 不是保守,是这个运行环境能容纳的上限。**
   *
   * 生产实测的单次调用耗时(全部成功):
   *   41s · 41s · 65s · 70s · 98s · 111s · 139s · 154s
   * 中位数约 84 秒,最长 154 秒。而 Vercel 的函数上限是 300 秒、
   * 本次运行的预算是 240 秒 —— 也就是**最多装得下 2~3 步**。
   *
   * 此前这里写的是 12。按中位数算需要 1000 秒以上,从写下的第一天起
   * 就不可能达成:实际表现永远是跑两三步、预算耗尽、报「已达到时间上限」。
   * 承诺一个做不到的数字,和界面上写「已接通」而其实没通是同一件事。
   *
   * 真正的长任务要靠后台 Worker,不是靠把这个数字调大。
   */
  readonly maxSteps: number;
  /** 总时间预算(毫秒),必须留在平台函数时限之内 */
  readonly budgetMs: number;
  /** 连续失败多少次就停 —— 一直失败说明它没在改正,再试也是浪费 */
  readonly maxConsecutiveFailures: number;
  /**
   * 单步最多重试几次(同一个模型)。
   *
   * 10 是 Claude Code 的默认值(CLAUDE_CODE_MAX_RETRIES),照抄。
   * 实际很难跑满 —— 退避时间还要受剩余预算约束,而我们的预算被
   * Vercel 的 300 秒硬顶压着,Claude Code 在本机跑没有这个限制。
   */
  readonly maxRetries: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  // 步数上限回到 12。
  //
  // 我曾把它压到 3,理由是「单步中位数 84 秒,240 秒装不下更多」。
  // 那个算术没错,但结论错了:**真正的界限是 budgetMs,不是步数**。
  // 一步快就多跑几步,一步慢自然就少跑几步 —— 用步数再卡一道,
  // 只会在模型很快的时候平白截断一次本来能完成的任务。
  //
  // 留 12 是防「模型在两个工具之间反复横跳」的兜底,不是时间预算的替身。
  maxSteps: 12,
  // 285 秒 = 平台给的全部时间(Vercel 函数上限 300 秒,留 15 秒收尾)。
  // 这不是我们挑的数,是墙在那里。智能体要跑得更久,只能把执行搬出
  // 无服务器函数 —— 那正是接 OpenClaw / Hermes 的意义。
  budgetMs: 285_000,
  maxConsecutiveFailures: 3,
  maxRetries: 10,
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
 * 用户选定的「服务商 + 模型」。凭据必须和模型名成对传 ——
 * 只带模型名、凭据另取一家,跑的就不是用户选的那个东西。
 */
export interface AgentModelOption {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly credentials: ProviderCredentials;
}

/** 循环过程中的进度回调,用于把每一步实时推给前端 */
export interface AgentReporter {
  onStep?(step: AgentStep): void;
  /**
   * 模型正在说的话,逐段推出去。
   *
   * Claude 的智能体设计:循环的每一轮都是一次独立的**流式**请求。
   * 没有这一条,一步跑两三分钟期间前端一个字都没有,用户只能判断为卡死 ——
   * 而它其实正常工作着。
   */
  onText?(text: string): void;
}

/**
 * 跑一次智能体循环。
 *
 * @param userMessage 本轮用户的要求(已含项目文件与检索材料等上下文)
 * @param history 之前的对话,按时间正序
 */
export async function runAgent({
  model,
  userMessage,
  history,
  toolContext,
  gitContext,
  signal,
  limits = DEFAULT_LIMITS,
  reporter,
}: {
  /**
   * 用哪个「服务商 + 模型」跑。**就这一个,不换。**
   *
   * 这里曾经是一条候选链,失败就自动换下一个接着跑。删掉了。
   *
   * 真实后果不是「换了个模型」,是**留痕自相矛盾**:用户选了 A,
   * messages.model_id 记的是 A,而正文里由系统写了一句「改用过 B」——
   * 同一条记录两个模型名。用户没法判断哪个是真的,
   * 合理的结论就是这段文字是编的。
   *
   * 选哪个模型是用户的决定。跑不通就如实报错,让他自己换。
   */
  model: AgentModelOption;
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
  let toolSupport: "observed" | "rejected" | null = null;
  /**
   * 服务商拒绝过 tool_choice: "required" 之后,本次运行不再强制。
   *
   * 有些服务商支持 tools 但不认 "required" 这个取值。那种情况下
   * 硬顶着重试只会把每一步都撞死,而它其实是能调工具的。
   */
  let forceDisabled = false;
  for (let index = 1; index <= limits.maxSteps; index++) {
    // 界限只有「本次运行还剩多少时间」—— 不另设任何人为上限。
    // callWithTools 拿它当超时:上游一个字节都不回时,没有超时就会
    // 一路挂到平台强杀,连接直接断开,浏览器只报「Failed to fetch」。
    const remaining = limits.budgetMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      haltReason = "本次运行已达到平台的时间上限。";
      break;
    }

    // 这一步的调用,带**重试**。
    //
    // 做法照抄 Claude Code 官方文档(code.claude.com/docs/en/errors):
    //   「Claude Code retries these failures: Server errors, overloaded
    //    responses, and request timeouts … Temporary 429 throttles.」
    // 默认 CLAUDE_CODE_MAX_RETRIES = 10,指数退避,**重试用尽之前
    // 根本不把这个错误给用户看**。
    //
    // 此前这里是收到错误就直接抛,整轮打死。生产实况:上游回一个
    // 529 overloaded(意思是「忙,等会儿再来」),我们把它当成终局,
    // 一次都不试就把用户十几步的活全毁了。Claude Code 官方仓库的
    // issue #60577 记的就是这个缺陷,而文档写明的应有行为是自动重试。
    //
    // 重试的是**同一个模型**,不换 —— 这和「你选哪个就用哪个」不冲突,
    // 换模型才冲突。
    let turn;
    let attempt = 0;
    for (;;) {
      // 只要重发,就可能把同一个工具调用执行两遍。所以按 Claude 的规则:
      // 这一次尝试里只要已经吐出过内容,就不再重发。见下面 emitted。
      let emitted = false;
      const left = limits.budgetMs - (Date.now() - startedAt);
      if (left <= 0) {
        haltReason = "本次运行已达到平台的时间上限。";
        break;
      }

      try {
        turn = await callWithTools({
          credentials: model.credentials,
          model: model.modelId,
          messages,
          tools: gitContext ? [...FILE_TOOLS, ...GIT_TOOLS] : FILE_TOOLS,
          // 第一步强制动工具,之后放开。
          //
          // 「智能体」和「聊天助手」的分界线是产物落进工作区,而不是贴在
          // 回答正文里。此前这里一律 "auto",于是模型可以完全无视工具 ——
          // 而它真的会:一次真实运行里,模型收到全套文件工具、系统提示词
          // 第一句就是「任何产物都必须用 write_file 写进工作区」,
          // 它照样花 40 秒写了 1196 token 散文,工作区 0 文件。
          // 贴在正文里的东西用户还要手工复制粘贴,那等于没做。
          //
          // 只强制第一步:后面必须放开,否则模型永远收不了尾 ——
          // 「这一轮不调工具」正是它宣告任务完成的方式。
          // 第一步强制去 list_files 看一眼工作区,本来就是它该做的第一件事。
          toolChoice: index === 1 && !forceDisabled ? "required" : "auto",
          signal,
          timeoutMs: left,
          // 模型说的话实时推给前端,不等这一步跑完。
          // 顺带记下「这一次尝试有没有真的吐出过东西」——重试的前提是没吐过。
          onText: (text: string) => {
            emitted = true;
            reporter?.onText?.(text);
          },
        });
        break;
      } catch (e) {
        // 连接断了 vs 上游明确回了一个错误 —— 这两件事必须分开。
        //
        // ProviderCallError 表示我们**收到了 HTTP 响应**并据此分了类
        // (状态码、上游原话都在)。抛出别的东西,意味着传输层就断了:
        // fetch failed、流读到一半 connection reset、TLS 握手失败……
        // 这时既没有状态码也没有上游原话。
        //
        // 此前这里一律包成 `new ProviderCallError("调用模型服务失败。")`,
        // 原始消息整个丢掉。后果是 isTransientFailure 拿到的是
        // (undefined, "调用模型服务失败。") —— 判成永久性失败,一次都不重试。
        // 而 Claude Code 官方文档把断连明确列在**要重试**的一类里:
        //   「Dropped connections. This covers a connection that drops in
        //    the middle of a request, before any part of Claude's response
        //    has completed: Claude Code re-issues the request with the same
        //    backoff, and the turn continues.」
        // 所以断连要保留原文,并且直接按临时性失败处理。
        const dropped = !(e instanceof ProviderCallError);
        const err = dropped
          ? new ProviderCallError(
              `与模型服务的连接中断:${e instanceof Error ? e.message : String(e)}`,
            )
          : e;

        // 用户自己中止(关页面、点停止)不是失败,不重试
        if (signal.aborted) throw err;

        // 服务商在拒绝 tools / tool_choice 这两个参数本身。
        //
        // 分两步退让,顺序不能反 —— 这两件事完全不同:
        //   1. 先只把「强制」摘掉。有的服务商支持 tools,但不认
        //      tool_choice: "required" 这个取值。这时它其实能调工具,
        //      硬顶着只会把每一步都撞死。
        //   2. 摘掉强制还是被拒,才说明它根本不接受 tools ——
        //      这时才算拿到了「不支持工具调用」的确凿证据。
        if (TOOLS_REJECTED.test(err.message)) {
          if (!forceDisabled) {
            forceDisabled = true;
            logger.warn(
              { model: model.modelId, upstream: err.message },
              "服务商拒绝 tool_choice: required,本次运行改为不强制",
            );
            continue;
          }
          toolSupport = "rejected";
          throw err;
        }

        // 已经吐出过内容就不重发。
        //
        // 这条是 Claude 官方明确列在「不重试」里的,理由是我猜不到的:
        //   「Claude Code could execute the same tool calls twice if it
        //    re-ran the request, so it keeps the completed output and
        //    ends the turn with an incomplete-response notice.」
        // 也就是说,重发一个已经开始产出的请求,会让同一个 write_file
        // 执行两遍。宁可这一轮不完整,也不能把文件写两次。
        if (emitted) throw err;

        // 永久性失败(密钥错、模型不存在)重试多少次都一样,只是白烧配额。
        // 断连没有状态码可判,但它按定义就是临时性的 —— 见上面的引文。
        if (!dropped && !isTransientFailure(err.status, err.message)) throw err;

        attempt += 1;
        if (attempt > limits.maxRetries) throw err;

        // 指数退避 1s / 2s / 4s / 8s,封顶 8 秒。
        //
        // 上限还要受**剩余预算**约束:Vercel 的函数最长 300 秒,
        // 这是平台强制的,不是我们的判断。等待时间超过剩余预算的话,
        // 与其睡过去被平台强杀(浏览器只报 Failed to fetch),
        // 不如现在就如实报错。
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
        if (backoff >= limits.budgetMs - (Date.now() - startedAt)) throw err;

        logger.warn(
          {
            model: model.modelId,
            attempt,
            status: err.status,
            backoffMs: backoff,
          },
          "上游临时失败,退避后重试同一个模型",
        );
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    // 预算在重试过程中耗光了
    if (!turn) break;

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
      // 此时工具调用的参数是残缺 JSON,执行会写出半截文件
      haltReason = "模型输出被长度上限截断。";
      steps.push({ index, text: turn.text, tools: [] });
      reporter?.onStep?.({ index, text: turn.text, tools: [] });
      break;
    }

    // 没有工具调用 = 模型认为这一轮结束了。以上游的信号为准,不自作主张续跑。
    //
    // 这里不能反过来「它只想了想,那我再让它跑一轮」并把思考塞回 messages
    // 当助手发言 —— 模型看见自己上一轮的独白会接着独白,一路烧到步数上限。
    // 思考过程不是对话内容,不进 messages。
    if (turn.toolCalls.length === 0) {
      // 正文为空但有思考过程时,显示思考过程。
      //
      // 它同样是**模型自己的话**,不是我们写的旁白,所以可以直接给用户看,
      // 而且不加任何包装说明。空白气泡对用户毫无信息量。
      //
      // 但它只在这里(模型已经停下)顶替正文。gateway 里 text 与 reasoning
      // 始终是分开的两个字段 —— 一旦在循环中途混起来,智能体会把「它在想」
      // 判成「它答完了」,第一步就收工,工作区 0 文件。
      answer = turn.text.trim() !== "" ? turn.text : turn.reasoning;
      if (answer.trim() === "") {
        // 模型既没有调工具也没有说话。
        //
        // 不写任何叙述:空回答本身就是事实,而任何解释都是我在猜
        // (上一次猜的两条原因都不对,真实原因是我们自己把请求发成了
        // 非流式 —— 用户照着那两句话查了一星期)。
        // 排查要用的东西在留痕里:messages 有 model_id 与耗时,
        // 日志里有上游的 finish_reason。
        logger.warn(
          { model: model.modelId, finishReason: turn.finishReason },
          "智能体本轮无输出",
        );
      }
      steps.push({ index, text: turn.text, tools: [] });
      reporter?.onStep?.({ index, text: turn.text, tools: [] });
      break;
    }

    // 亲眼见到它发出 tool_calls —— 这是「支持工具调用」唯一算数的证据
    toolSupport = "observed";

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

    // 这一轮说的话先存下来。下面三条退出路径(连续失败、步数用完、
    // 时间用完)都不经过前面的 break —— 不在这里赋值的话,撞上护栏时
    // 返回的 answer 是空字符串,界面上就是一片空白。
    if (turn.text.trim() !== "") answer = turn.text;

    const step: AgentStep = { index, text: turn.text, tools: results };
    steps.push(step);
    reporter?.onStep?.(step);

    // 连续失败说明模型没在改正,再循环只是浪费配额
    const allFailed = results.every((r) => !r.ok);
    consecutiveFailures = allFailed ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= limits.maxConsecutiveFailures) {
      haltReason = `工具连续 ${consecutiveFailures} 次执行失败,已停止。`;
      break;
    }

    if (index === limits.maxSteps) {
      haltReason = `已达到步数上限(${limits.maxSteps} 步)。`;
    }
  }

  return {
    answer,
    steps,
    inputTokens,
    outputTokens,
    haltReason,
    toolSupport,
  };
}

/**
 * 取这次运行要显示在对话框里的文字。
 */
export function summarizeRun(outcome: AgentOutcome): string {
  // 只回模型自己说的话。
  //
  // 这里曾经由我拼一段叙述:写了几个文件、换过哪些模型、为什么停下。
  // 用户明确要求这些不要出现在界面和代码里 —— 那些话是系统在旁白,
  // 不是模型的回答,而对话框里应当只有「模型说了什么」。
  //
  // 事实并没有丢:产物在工作区里看得见,用过哪个模型 messages.model_id
  // 记着,每一步的工具执行由 SSE 的 step 事件实时推过。
  return outcome.answer.trim();
}
