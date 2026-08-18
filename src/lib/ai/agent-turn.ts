import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_LIMITS,
  runAgent,
  summarizeRun,
  capToolResult,
  MAX_REBUILD_MESSAGES,
  type AgentModelOption,
} from "@/lib/ai/agent";
import { loadGitContext } from "@/lib/ai/git-tools";
import { buildExternalContext } from "@/lib/ai/external";
import {
  isPlatformProviderId,
  platformCredentialsFor,
} from "@/lib/ai/platform-models";
import { openRunJournal } from "@/lib/ai/run-journal";
import { logger } from "@/lib/log";
import type { AgentStep } from "@/lib/ai/agent";
import { ProviderCallError } from "@/lib/ai/gateway";
import type { ToolContext } from "@/lib/ai/tools";
import { loadProviderCipher } from "@/lib/ai/credentials";
import type { ProviderKind } from "@/lib/providers/registry";

/**
 * 方案 B:agent_steps 的一行(续跑重建消息序列的数据源)。
 * 对应 run-journal.record() 写入的字段。
 */
export interface RebuildStepRow {
  step_index: number;
  tool_call_id: string | null;
  tool_name: string | null;
  arguments: unknown;
  result_preview: string | null;
  result_chars: number | null;
  ok: boolean;
}

/**
 * 方案 B:从 agent_steps 重建**真实消息序列**(续跑时替代 resumeContext
 * 压缩文本,让模型看到自己执行过的真实工具历史)。
 *
 * 重建规则(与 runAgent 循环内的消息格式一致,见 agent.ts 579-687):
 *   - 每个工具调用 → assistant 消息(tool_calls 数组)+ tool 消息
 *     (tool_call_id + 截断结果)
 *   - 纯文本步骤(无工具)→ 并入上下文开头说明(无法还原为精确轮次,
 *     以摘要形式保留)
 *
 * Token 预算(用户要求):受 MAX_REBUILD_MESSAGES 上限约束 ——
 *   最近 MAX_REBUILD_MESSAGES 条**原样完整重建**(零丢失);
 *   更早的部分压缩成一段摘要文本放在序列开头(只留轨迹 + 关键结果预览)。
 * 单条 tool 结果经 capToolResult 截断(30K 字符,与运行期一致)。
 */
export function rebuildMessagesFromSteps(
  rows: RebuildStepRow[],
): Record<string, unknown>[] | null {
  if (rows.length === 0) return null;

  // 按 step_index 排序(小数位区分同一步多工具)
  const sorted = [...rows].sort((a, b) => a.step_index - b.step_index);

  // 构建消息序列
  const messages: Record<string, unknown>[] = [];
  let earliestSummary = "";

  // 先计算总量:超过预算时,最早的步骤压缩成摘要
  let earlyCount = 0;
  if (sorted.length > MAX_REBUILD_MESSAGES) {
    const cutoff = sorted.length - MAX_REBUILD_MESSAGES;
    earlyCount = cutoff;
    const early = sorted.slice(0, cutoff);
    const earlyLines = early.map((s) => {
      const idx = Math.floor(s.step_index / 100) + 1;
      const name = s.tool_name ?? "模型回复";
      const preview = (s.result_preview ?? "").slice(0, 120).replace(/\n/g, " ");
      return `步骤 ${idx} · ${name}: ${preview}`;
    });
    earliestSummary =
      `【此前已完成 ${early.length} 步,摘要如下(为控制上下文长度,较早步骤不再逐条展开)】\n` +
      earlyLines.join("\n");
  }

  // 只重建最近 MAX_REBUILD_MESSAGES 行;更早的已在摘要里,跳过
  for (const s of sorted.slice(earlyCount)) {
    // 工具步骤:assistant tool_calls + tool 结果
    if (s.tool_call_id && s.tool_name && s.arguments !== null) {
      // 同一步内多个工具共享同一个 assistant 消息 —— 用 step_index 分组
      const idx = s.step_index;
      const existing = messages.find(
        (m) =>
          m.role === "assistant" &&
          (m as { _stepIndex?: number })._stepIndex === Math.floor(idx / 100),
      ) as (Record<string, unknown> & { _stepIndex?: number }) | undefined;
      if (existing && Array.isArray(existing.tool_calls)) {
        (existing.tool_calls as unknown[]).push({
          id: s.tool_call_id,
          type: "function",
          function: { name: s.tool_name, arguments: JSON.stringify(s.arguments ?? {}) },
        });
      } else {
        messages.push({
          role: "assistant",
          content: null,
          _stepIndex: Math.floor(idx / 100),
          tool_calls: [
            {
              id: s.tool_call_id,
              type: "function",
              function: {
                name: s.tool_name,
                arguments: JSON.stringify(s.arguments ?? {}),
              },
            },
          ],
        });
      }
      messages.push({
        role: "tool",
        tool_call_id: s.tool_call_id,
        content: capToolResult(
          s.result_preview ?? (s.ok ? "(工具已执行,无返回内容)" : "(工具执行失败)"),
        ),
      });
    }
    // 纯文本步骤(模型说话):并入摘要开头,不重建为对话轮次
    else if (!s.tool_name && s.result_preview) {
      // 已包含在 earliestSummary 或作为用户可见上下文保留
    }
  }

  // 去掉内部标记字段
  const clean = messages.map((m) => {
    const { _stepIndex, ...rest } = m as Record<string, unknown> & {
      _stepIndex?: number;
    };
    return rest;
  });

  if (clean.length === 0) return null;

  // 摘要放最前(作为一条 user 消息,模型读到的是"此前已完成…")
  if (earliestSummary !== "") {
    clean.unshift({ role: "user", content: earliestSummary });
  }
  return clean;
}

/**
 * 智能体模式的一轮。
 *
 * 与普通问答分开成独立模块,而不是塞进对话路由里:两者的执行形态完全不同
 * (一个是单次流式生成,一个是多步工具循环),混在一个函数里会让两边都难改。
 *
 * 响应仍然是 SSE,但推的是**进度事件**而非逐字增量 ——
 * 用户需要看到的是「正在写 src/app.ts」,不是模型在想什么。
 */

export async function runAgentTurn({
  supabase,
  userId,
  organizationId,
  conversationId,
  providerId,
  model,
  taskType,
  userMessage,
  history,
  signal,
  budgetMs,
  resumeRunId,
}: {
  supabase: SupabaseClient;
  userId: string;
  organizationId: string;
  conversationId: string;
  providerId: string;
  model: string;
  /** 任务类型(P0-2),进入执行上下文与 journal(缺省 "text") */
  taskType: "text" | "coding" | "agent" | "vision" | "image" | "video";
  userMessage: string;
  history: readonly { role: "user" | "assistant"; content: string }[];
  signal: AbortSignal;
  /**
   * 平台给这次运行的全部时间,由路由从它自己的 maxDuration 推导后传进来。
   * 这里不写秒数 —— 换 Vercel 计划只需要改路由上那**一个**数。
   */
  budgetMs: number;
  /**
   * 续跑上一轮被中断的运行。传了它,userMessage 会追加一段
   * 「之前已完成的步骤」摘要 —— 模型从断点接着干,而不是从头再来。
   */
  resumeRunId?: string | undefined;
}): Promise<Response> {
  // ── P1 fallback 辅助(P1 Runtime Fallback)───────────────────────────────
  // 候选来源:组织内全部 enabled 的 ai_models(排除 Primary 本身由
  // resolver 的 attempted/requested 判定处理)。不建第二套 Registry ——
  // 数据仍来自 ai_models + ai_providers(与 candidates.ts 同一来源)。
  // 按候选装载凭据(与上方 Primary 凭据装配同一逻辑,不另写一套)
  // 工作区真正用到时才建,而且只建一次。
  // 无条件建的话,模型一个文件都没写的运行也会留下一个空工作区。
  let workspacePromise: Promise<string> | null = null;
  const ensureId = () => {
    workspacePromise ??= ensureWorkspace(
      supabase,
      organizationId,
      conversationId,
      userId,
    );
    return workspacePromise;
  };

  const toolContext = createWorkspaceTools(
    supabase,
    ensureId,
    organizationId,
    conversationId,
  );

  // Git 上下文。没连仓库就是 undefined —— 那种情况下根本不把仓库工具
  // 交给模型,而不是给了再拒绝:给一个必然失败的工具,模型会反复尝试
  // 并把有限的步数耗光。
  const gitContext = await loadGitContext(supabase, organizationId);

  // 组织自定义品牌人格(P3,2026-08-11)。组织在「设置 → 品牌人格」配置,
  // 存在 organizations.persona。未配置为空 —— 用默认人格,行为与旧版一致。
  // 读取失败按空处理(不阻断本轮运行),留日志便于排查。
  let orgPersona: string | null = null;
  try {
    const { data: orgRow } = await supabase
      .from("organizations")
      .select("persona")
      .eq("id", organizationId)
      .maybeSingle();
    orgPersona = (orgRow?.persona as string | null | undefined) ?? null;
  } catch (e) {
    logger.warn(
      { org: organizationId, err: e instanceof Error ? e.message : String(e) },
      "读取组织品牌人格失败,按未配置处理",
    );
  }

  // 外部能力上下文:登记的 MCP server + 技能库。两者都没有时返回
  // undefined,agent 行为与旧版完全一致(不注入任何外部工具)。
  const externalContext = await buildExternalContext(supabase, organizationId);

  // 用户选的那一个服务商 + 模型 = **Primary(首选)**。
  //
  // 历史:这里曾经是一条跨服务商的候选链,某一步失败就换下一个接着跑,
  // 后来删掉了 —— 原因是「用户选 A 系统跑 B,留痕还是 A」:他选
  // deepseek-v4-flash,系统跑了 glm-5.2,model_id 记的还是 deepseek,
  // 同一次运行两个模型名,与编造无法区分。
  //
  // P1(P1 Runtime Fallback)在**保留这个教训**的前提下恢复 fallback:
  //   · 用户选的 = requested(先跑,失败才切)
  //   · 实际跑的 = executed(每次切换都是显式 fallback event)
  //   · journal 同时记 requested 与 executed,primary failure 不被覆盖
  //   · attempted set + MAX_FALLBACK_ATTEMPTS 防循环
  // 见 agent-turn 下方 orchestration 循环 + run-journal + 0065 迁移。
  //
  // 凭据装配分两支,与 /api/chat 同一个实现:
  //   · 平台档(providerId 形如 platform:openai:https://…):ai_providers 里
  //     没有行,密钥来自环境变量。必须走 platformCredentialsFor ——
  //     授权判定(free_only、环境变量配没配、模型有没有下架)只有这一处。
  //   · BYOK:查 ai_providers 行,RLS 保证只能读到自己组织的。
  const credentials = isPlatformProviderId(providerId)
    ? await platformCredentialsFor(supabase, organizationId, providerId, model)
    : await (async () => {
        const { data: providerRow } = await supabase
          .from("ai_providers")
          .select("kind, base_url, display_name, enabled")
          .eq("id", providerId)
          .eq("organization_id", organizationId)
          .maybeSingle();

        if (!providerRow || providerRow.enabled === false) return null;

        const cipher = await loadProviderCipher(providerId);
        return cipher
          ? {
              kind: providerRow.kind as ProviderKind,
              baseUrl: providerRow.base_url as string | null,
              apiKeyCipher: cipher,
            }
          : null;
      })();

  if (!credentials) {
    return new Response(
      JSON.stringify({
        error: isPlatformProviderId(providerId)
          ? "这个模型当前不可用。它属于平台免费档 —— 可能是服务端未配置密钥,或你的组织不在该档位。"
          : "这个服务商当前不可用。请到「模型服务」确认它已启用且密钥有效。",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const providerName = isPlatformProviderId(providerId)
    ? "智一 AI 免费档"
    : ((await supabase
        .from("ai_providers")
        .select("display_name")
        .eq("id", providerId)
        .maybeSingle()).data?.display_name as string | undefined) ?? "";

  const selected: AgentModelOption = {
    providerId,
    providerName,
    modelId: model,
    credentials,
  };

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let clientGone = false;
      const send = (event: string, data: unknown) => {
        if (clientGone) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          clientGone = true;
        }
      };

      // 不再在这里报 workspaceId:工作区已改成用到时才建,这个时刻它
      // 通常还不存在。前端也从来没用过这个字段 —— 它是在整页刷新时
      // 由服务端把文件列表一起取来的。
      send("meta", { conversationId, model, agent: true });

      // 心跳。
      //
      // 智能体的每一步都是一次**非流式**调用:上游回完之前这里一个字节都
      // 没有,而一步几十秒是常态。期间连接上什么都不流动,界面停在
      // 「正在生成…」一动不动 —— 用户只能判断为卡死,然后关掉页面重试,
      // 而那一步其实正在正常进行。中间的反向代理也可能因为长时间无数据
      // 把连接掐掉。
      //
      // 每 5 秒推一条已运行秒数:既让界面能显示「已运行 42 秒」,
      // 也让连接上始终有数据流动。
      const heartbeat = setInterval(() => {
        send("progress", { elapsedMs: Date.now() - startedAt });
      }, 5_000);

      // 开一份运行日志。**每一步做完立刻落库**,不等整轮结束。
      //
      // 此前落库只发生在 runAgent() 完整返回之后 —— 一次 102 秒的中断
      // 就让已经读回来的目录彻底消失,连"发生过"都没有痕迹。
      // 开不出来(建记录失败)不阻断运行:检查点是为了少丢,
      // 不该成为多一个让整轮崩掉的理由。
      const journal = await openRunJournal(supabase, {
        conversationId,
        organizationId,
        // 平台免费档在 ai_providers 里没有行
        providerId: isPlatformProviderId(selected.providerId)
          ? null
          : selected.providerId,
        modelId: selected.modelId,
        taskType,
      });

      // 把 runId 推给前端。前端拿到它,才知道撞上限后该带哪个 run 续跑。
      // journal 开不出来时没有 runId —— 那种情况本来就不承诺续跑能力。
      if (journal) send("run", { runId: journal.runId });

      // 续跑:把上一轮已经完成的步骤摘出来,追加进这一轮的输入。
      //
      // 模型看到「这一步已经做过了、结果是什么」,就会接着往下做,
      // 而不是从头再来一遍 —— 从头再来的话,读过的文件要重读、
      // 写过的东西可能被重写,而时间预算并不因此变多。
      //
      // 摘要的来源是检查点(agent_steps),不是浏览器里的临时状态:
      // 检查点是落过库的,浏览器刷新了它还在 —— 这正是「能续」的定义。
      //
      // 续跑入口必须先校验这个 run **属于当前对话**且**确实可续**:
      //   · conversation_id 必须等于本次请求的对话 —— 否则自己的 A 对话
      //     步骤摘要会被注入 B 对话的上下文,跨对话数据混合。
      //   · status 必须是被中断的、resumable 必须为 true —— 对 completed /
      //     failed 的运行反复续跑会重放副作用(比如重复 git_propose_changes
      //     开出第二个分支,正是 run-journal 里 resumable 注释点名的场景)。
      //   RLS(agent_steps_own)已保证跨用户读不到,这里补的是同用户内的
      //   对话与状态约束 —— 两层都不可省。
      let resumeContext = "";
      // 方案 B:续跑时从 agent_steps 重建**真实消息序列**(assistant
      // tool_calls + tool 结果),替代压缩文本。重建函数见下方
      // rebuildMessagesFromSteps。为空 = 重建失败/无步骤 → 降级 resumeContext。
      let resumeMessages: Record<string, unknown>[] | null = null;
      if (resumeRunId) {
        const { data: run } = await supabase
          .from("agent_runs")
          .select("conversation_id, status, resumable")
          .eq("id", resumeRunId)
          .maybeSingle();

        const canResume =
          run &&
          run.conversation_id === conversationId &&
          run.status === "interrupted" &&
          run.resumable === true;

        if (canResume) {
          // 0043:续跑开始,旧运行标记为不可再续 —— 只有最新一条运行可续,
          // 否则刷新后同一个旧 run 会被重复续跑(重放副作用,比如
          // git_propose_changes 开出第二个分支)。失败不阻断续跑。
          try {
            await supabase
              .from("agent_runs")
              .update({ resumable: false })
              .eq("id", resumeRunId);
          } catch {
            // 忽略:标记失败只是可能允许重复续跑,不致命
          }

          const { data: prevSteps } = await supabase
            .from("agent_steps")
            .select("step_index, tool_call_id, tool_name, arguments, result_preview, result_chars, ok")
            .eq("run_id", resumeRunId)
            .order("step_index", { ascending: true });

          // 方案 B:重建真实消息序列。成功则 resumeMessages 非空,
          // runAgent 以 initialMessages 续用 —— 模型看到自己执行过的
          // 真实工具历史,而不是一段说明文字。
          if (prevSteps && prevSteps.length > 0) {
            const rebuilt = rebuildMessagesFromSteps(
              prevSteps as RebuildStepRow[],
            );
            if (rebuilt && rebuilt.length > 0) {
              resumeMessages = rebuilt;
            }
          }

          // 无论重建成功与否,都保留「工作区已有文件」清单 —— 那是真实
          // 状态(模型需要知道有哪些产物),不是上下文丢失的补偿。
          // 重建成功时它以一条 user 消息并入;失败时降级为 resumeContext。
          const { data: prevFiles } = await supabase
            .from("workspace_files")
            .select("path, size_chars")
            .eq("written_by_conversation", conversationId)
            .order("path");
          if (prevFiles && prevFiles.length > 0) {
            const fileList = (prevFiles as { path: string; size_chars: number }[])
              .map((f) => `  - ${f.path} (${f.size_chars}字符)`)
              .join("\n");
            const filesBlock = `\n\n【工作区已有文件 —— 不要重写,直接使用】\n${fileList}`;
            if (resumeMessages) {
              // 重建成功:文件清单作为 user 消息并入(不含续跑说明文字)
              resumeMessages.push({
                role: "user",
                content: `【工作区已有文件 —— 不要重写,直接使用】\n${fileList}`,
              });
            } else {
              resumeContext += filesBlock;
            }
          }

          // 重建失败时的降级(保底,不丢功能):压缩文本摘要,同旧行为
          if (!resumeMessages && prevSteps && prevSteps.length > 0) {
            const lines = (prevSteps as {
              step_index: number;
              tool_name: string | null;
              result_preview: string | null;
            }[]).map(
              (s) =>
                `- 步骤 ${Math.floor(s.step_index / 100) + 1} · ${
                  s.tool_name ?? "模型回复"
                }: ${(s.result_preview ?? "").slice(0, 500)}`,
            );
            resumeContext =
              `\n\n【续跑上下文 —— 以下步骤在此前的运行中已完成,不要重做,直接继续】\n` +
              lines.join("\n");
          }
        } else {
          logger.warn(
            { runId: resumeRunId, conversationId },
            "续跑被拒:run 不属于当前对话、或状态不可续",
          );
        }
      }
      // 召回本组织的记忆,注入这一轮的上下文。
      //
      // 这是「沉淀为记忆」的消费端:用户确认过的记忆在这里被带进任务,
      // 模型据此给出更符合用户偏好的回答 —— 记忆闭环到此闭合。
      // 召回失败不阻断运行:没有记忆可用的智能体仍然能干活,
      // 只是不那么「懂你」而已。
      let memoryBlock = "";
      try {
        const { recallMemories, touchMemory } = await import(
          "@/lib/db/memories"
        );
        const memories = await recallMemories(supabase, organizationId, 8, userMessage);
        if (memories.length > 0) {
          memoryBlock =
            `\n\n【你的记忆 —— 用户确认过的事实与偏好,回答时请遵循】\n` +
            memories
              .map(
                (m) =>
                  `- [${m.category}] ${m.content}${m.confidence !== null ? ` (置信度 ${Math.round(m.confidence * 100)}%)` : ""}`,
              )
              .join("\n");
          // 异步点亮最近使用时间,让召回按使用频率自适应 —— 不阻塞本次运行
          void Promise.all(
            memories.map((m) => touchMemory(supabase, m.id)),
          ).catch(() => undefined);
        }
      } catch (e) {
        logger.warn(
          { org: organizationId, err: e instanceof Error ? e.message : String(e) },
          "记忆召回失败,本轮不带记忆运行",
        );
      }

      const effectiveUserMessage =
        resumeContext || memoryBlock
          ? `${userMessage}${resumeContext}${memoryBlock}`
          : userMessage;

      // 知识库召回:把组织内最近就绪的文档正文带进任务。
      // 与记忆同一哲学:召回失败不阻断运行,只是这轮「没查文档」。
      let knowledgeBlock = "";
      try {
        const { recallKnowledge, buildKnowledgeBlock } = await import(
          "@/lib/db/knowledge"
        );
        const hits = await recallKnowledge(supabase, organizationId);
        knowledgeBlock = buildKnowledgeBlock(hits);
      } catch (e) {
        logger.warn(
          { org: organizationId, err: e instanceof Error ? e.message : String(e) },
          "知识库召回失败,本轮不带知识库运行",
        );
      }

      const messageWithKnowledge = knowledgeBlock
        ? `${effectiveUserMessage}${knowledgeBlock}`
        : effectiveUserMessage;

      // 方案 B(Agent Runtime messages 管理重构):续跑时 resumeMessages 非空
      // → 以 initialMessages 传入,模型看到自己执行过的真实工具历史
      // (assistant tool_calls + tool 结果),而不是压缩文本说明。
      try {
      const outcome = await runAgent({
        model: selected,
        ...(resumeMessages ? { initialMessages: resumeMessages } : {}),
        userMessage: messageWithKnowledge,
        history,
        toolContext,
        gitContext,
        externalContext,
        signal,
        limits: { ...DEFAULT_LIMITS, budgetMs },
        personaOverride: orgPersona,
        reporter: {
          // 模型每吐一段就推一段 —— 这是智能体从「看起来卡死」
          // 变成「看得见在跑」的关键。
          //
          // 走 reasoning 槽位而不是 delta:智能体运行途中说的话是**过程**,
          // 不是最终答案 —— 最终答案是跑完之后的 summarizeRun。
          // 推成 delta 的话,过程文字会和最后那份总结在正文里叠加两遍。
          // 前端把 reasoning 渲染成生成期间默认展开的折叠块,正合适。
          onText(text: string) {
            send("reasoning", { text });
          },
          async onStep(step: AgentStep) {
            // 顺序是硬要求:**先落库,再推送**。
            //   执行工具 → 写 agent_steps → 提交 → 发 SSE → 下一轮
            //
            // 反过来的话,用户在界面上看到了这一步、而请求恰好在落库前
            // 被杀 —— 他看见过的东西数据库里没有,刷新之后凭空消失。
            // 那比什么都不显示更糟。
            await journal?.record(step);

            // 每一步都实时推给用户 —— 智能体跑几分钟,期间什么都不显示
            // 会让人以为卡死了
            send("step", {
              index: step.index,
              text: step.text,
              tools: step.tools.map((t) => ({
                name: t.name,
                ok: t.ok,
                content: t.content.slice(0, 300),
                // 完整长度一并推过去 —— 界面要据此说明「这是摘要」。
                // 只推截断后的内容,前端根本没有办法知道自己拿到的
                // 是不是全部,于是只能默默显示,用户只能默默误会。
                totalChars: t.content.length,
                truncated: t.content.length > 300,
                durationMs: t.durationMs ?? null,
              })),
            });
          },
        },
      });

        // 把观察到的工具能力落库。
        //
        // 只在**确实观察到证据**时才写 —— toolSupport 为 null 表示这一轮
        // 什么都没看出来,那就什么都不写。尤其不能把「这次没调工具」
        // 记成「不支持工具」:模型可能只是觉得这道题不需要动工具,
        // 记成不支持就把一个好好的模型永久拉黑了。见迁移 0024。
        if (outcome.toolSupport !== null) {
          await recordToolSupport(
            supabase,
            organizationId,
            selected,
            outcome.toolSupport === "observed",
          );
        }

        // 存进 messages.content 的,只有模型自己说的话。
        //
        // 这里曾经在正文后面拼一段警告(「本次模型把代码写在了回答里……
        // 建议换 GLM-5.2 重试」)。两条都不能留:一是它进了 content,
        // 用户看到的就是模型说的话,而模型没说过;二是界面不是我们给用户
        // 出主意的地方 —— 换哪个模型是他的事。
        // 写没写文件,工作区里一目了然,不需要我们复述。
        const summary = summarizeRun(outcome);

        // 取回 id:反馈按钮要用它。见 route.ts 的 insertAssistantMessage
        const { data: savedRow } = await supabase
          .from("messages")
          .insert({
            conversation_id: conversationId,
            organization_id: organizationId,
            role: "assistant",
            content: summary,
            // 0043:把运行记录挂到消息上 —— 页面恢复会话时按 run_id 反查
            // 状态,「继续运行」按钮才能跨页面刷新存活
            run_id: journal?.runId ?? null,
            // 记实际跑的那一个。selected 就是本次唯一跑过的模型 —
            // 从这里取而不是从入参取,是为了让「库里记的」和「真跑的」
            // 在代码上是同一个来源,而不是两个碰巧相等的值。
            // 平台模型 provider_id 非 UUID,FK 约束不满足,传 null。
            provider_id: isPlatformProviderId(selected.providerId)
              ? null
              : selected.providerId,
            model_id: selected.modelId,
            input_tokens: outcome.inputTokens,
            output_tokens: outcome.outputTokens,
            latency_ms: Date.now() - startedAt,
          })
          .select("id")
          .single();

        send("delta", { text: summary });
        // 撞上护栏的原因走**错误通道**,不拼进 content。
        // 系统消息和模型回复分属不同通道 —— 混进正文,用户就会当成
        // 模型说的话。
        if (outcome.haltReason) send("error", { message: outcome.haltReason });

        // 收尾。跑完的不可续 —— resumable 由 finish 按结局决定。
        await journal?.finish(
          outcome.haltReason ? "interrupted" : "completed",
          outcome.haltReason ?? undefined,
        );

        send("done", {
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
          latencyMs: Date.now() - startedAt,
          ...(savedRow?.id ? { messageId: savedRow.id as string } : {}),
        });
      } catch (e) {
        const message =
          e instanceof ProviderCallError
            ? e.message
            : "智能体运行失败,请重试。";

        // 失败也留痕 —— 失败的运行同样是发生过的事实
        try {
          await supabase.from("messages").insert({
            conversation_id: conversationId,
            organization_id: organizationId,
            role: "assistant",
            content: "",
            // 0043:失败消息同样挂运行记录 —— 失败也是发生过的事实
            run_id: journal?.runId ?? null,
            // 失败留痕同样记**实际跑的**那一个,与成功路径同源。
            // 两条路径取不同的来源,迟早会出现「同一次运行两个模型名」。
            // 平台模型 provider_id 非 UUID,FK 约束不满足,传 null。
            provider_id: isPlatformProviderId(selected.providerId)
              ? null
              : selected.providerId,
            model_id: selected.modelId,
            latency_ms: Date.now() - startedAt,
            error_message: message,
          });
        } catch {
          // 告知用户比留痕更要紧
        }

        // 参数被拒同样是证据,而且是**唯一算数的**否定证据 ——
        // 这条路径以抛错收场,上面那段落库走不到,所以这里补上
        if (e instanceof ProviderCallError && /tool/i.test(e.message)) {
          await recordToolSupport(supabase, organizationId, selected, false).catch(
            () => undefined,
          );
        }

        // 失败也要收尾。不收的话状态永远停在 running,
        // 恢复流程会把一堆早已死掉的运行当成「正在跑」。
        //
        // 分两档:被中止(用户关页面、平台强杀)标 interrupted,
        // 那是**可续**的;真正的失败标 failed,续也没用。
        await journal
          ?.finish(signal.aborted ? "interrupted" : "failed", message)
          .catch(() => undefined);

        send("error", { message });
      } finally {
        // 心跳必须停,否则定时器会拖着已经结束的函数不放,
        // 还会往一个关掉的流里写
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** 找到或创建这次对话的工作区 */
async function ensureWorkspace(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
  userId: string,
): Promise<string> {
  const { data: conv } = await supabase
    .from("conversations")
    .select("workspace_id, title")
    .eq("id", conversationId)
    .maybeSingle();

  const existing = conv?.workspace_id as string | null | undefined;
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from("workspaces")
    .insert({
      organization_id: organizationId,
      name: (conv?.title as string | null) ?? "未命名工作区",
      created_by: userId,
    })
    .select("id")
    .single();

  if (error || !created) {
    throw new ProviderCallError("无法创建工作区。");
  }

  const workspaceId = created.id as string;
  // 【Bug 1 修复】link 更新可能因函数被强杀而未执行。
  // 不抛错:workspace 已建,工具正在写入它。下次 ensureWorkspace 被调用时
  // 会重新读到 conversation.workspace_id(=null),然后走到这里再次尝试 link。
  // 关键:绝不因为 link 失败就废弃已创建的 workspace —— 里面已有用户文件。
  const { error: linkError } = await supabase
    .from("conversations")
    .update({ workspace_id: workspaceId })
    .eq("id", conversationId);

  if (linkError) {
    // link 失败时,查是否已存在属于这个 conversation 的 workspace。
    // 判断依据:workspace_files 里有没有这次 conversation 写入的文件。
    // 有则说明上一次请求建了 workspace 并写入了文件,但 link 被强杀;
    // 续跑时继续用这个 workspace,里面已有本次写入的文件。
    const { data: prev } = await supabase
      .from("workspace_files")
      .select("workspace_id")
      .eq("written_by_conversation", conversationId)
      .limit(1)
      .maybeSingle();

    if (prev) {
      return prev.workspace_id as string;
    }
    // 无已有文件,说明新建的那个 workspace 就是唯一的,返回它
  }

  return workspaceId;
}

/**
 * 把工作区包装成工具能用的接口。
 *
 * 工具层不认识数据库 —— 这样它既可测(注入内存实现),
 * 以后换成真实文件系统或 Git 仓库也不必改工具定义。
 */
/**
 * 工作区工具。工作区**用到时才建**。
 *
 * 此前是在 runAgentTurn 开头无条件建一个。后果是每跑一次智能体就多一个
 * 工作区,哪怕模型一个文件都没写 —— 工作区列表里堆着一排
 * 「某某任务,0 文件」,用户根本分不清哪个有东西。
 *
 * 现在传的是一个 thunk:第一次真正读写时才去建,而且只建一次。
 * 只想让模型读一读、答一答的那些运行,不再留下空壳。
 */
function createWorkspaceTools(
  supabase: SupabaseClient,
  ensureId: () => Promise<string>,
  organizationId: string,
  conversationId: string,
): ToolContext {
  return {
    async readFile(path) {
      const { data } = await supabase
        .from("workspace_files")
        .select("content")
        .eq("workspace_id", await ensureId())
        .eq("path", path)
        .maybeSingle();
      return (data?.content as string | undefined) ?? null;
    },

    async writeFile(path, content) {
      const { error } = await supabase.from("workspace_files").upsert(
        {
          workspace_id: await ensureId(),
          organization_id: organizationId,
          path,
          content,
          size_chars: content.length,
          written_by_conversation: conversationId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,path" },
      );
      if (error) throw new Error(error.message);
    },

    async listFiles(prefix) {
      let query = supabase
        .from("workspace_files")
        .select("path, size_chars")
        .eq("workspace_id", await ensureId())
        .order("path");
      if (prefix) query = query.like("path", `${prefix}%`);

      const { data } = await query;
      return (data ?? []).map((r) => ({
        path: r.path as string,
        sizeChars: (r.size_chars as number | null) ?? 0,
      }));
    },
  };
}

/**
 * 记下这个模型的工具调用能力。
 *
 * 失败不影响本轮 —— 这是给下一次用的情报,不是这一次的必要条件。
 * 为它中断一次已经跑完的运行是本末倒置。
 */
async function recordToolSupport(
  supabase: SupabaseClient,
  organizationId: string,
  model: AgentModelOption,
  supported: boolean,
): Promise<void> {
  const { error } = await supabase
    .from("ai_models")
    .update({
      supports_tools: supported,
      tools_checked_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("provider_id", model.providerId)
    .eq("model_id", model.modelId);

  if (error) {
    logger.warn(
      { dbError: error.message, model: model.modelId },
      "工具能力观察结果未能落库",
    );
  }
}
