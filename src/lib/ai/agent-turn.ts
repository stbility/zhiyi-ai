import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_LIMITS,
  runAgent,
  summarizeRun,
  type AgentModelOption,
} from "@/lib/ai/agent";
import { loadGitContext } from "@/lib/ai/git-tools";
import { isPlatformProviderId } from "@/lib/ai/platform-models";
import { openRunJournal } from "@/lib/ai/run-journal";
import { logger } from "@/lib/log";
import type { AgentStep } from "@/lib/ai/agent";
import { ProviderCallError } from "@/lib/ai/gateway";
import type { ToolContext } from "@/lib/ai/tools";
import { loadProviderCipher } from "@/lib/ai/credentials";
import type { ProviderKind } from "@/lib/providers/registry";

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

  // 用户选的那一个服务商 + 模型。**不准备备用,也不自动换。**
  //
  // 这里曾经是一条跨服务商的候选链,某一步失败就换下一个接着跑。
  // 删掉了。用户的原话是「你选哪个就用哪个,不换」,而实际发生的事
  // 比「换了」更糟:他选 deepseek-v4-flash,系统跑了 glm-5.2,
  // 留痕里的 model_id 记的还是 deepseek —— 同一次运行,库里和界面上
  // 两个不一样的模型名。从用户那一侧看,这和编造无法区分。
  //
  // 模型不可用就如实报错,让他自己换。这是他的选择,不是我们的。
  const { data: providerRow } = await supabase
    .from("ai_providers")
    .select("kind, base_url, display_name, enabled")
    .eq("id", providerId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  const credentials =
    providerRow && providerRow.enabled !== false
      ? await (async () => {
          const cipher = await loadProviderCipher(providerId);
          return cipher
            ? {
                kind: providerRow.kind as ProviderKind,
                baseUrl: providerRow.base_url as string | null,
                apiKeyCipher: cipher,
              }
            : null;
        })()
      : null;

  if (!credentials) {
    return new Response(
      JSON.stringify({
        error:
          "这个服务商当前不可用。请到「模型服务」确认它已启用且密钥有效。",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const selected: AgentModelOption = {
    providerId,
    providerName: (providerRow?.display_name as string) ?? "",
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
      let resumeContext = "";
      if (resumeRunId) {
        const { data: prevSteps } = await supabase
          .from("agent_steps")
          .select("step_index, tool_name, result_preview")
          .eq("run_id", resumeRunId)
          .order("step_index", { ascending: true })
          .limit(100);

        if (prevSteps && prevSteps.length > 0) {
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
        const memories = await recallMemories(supabase, organizationId, 8);
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

      try {
        const outcome = await runAgent({
          model: selected,
          userMessage: effectiveUserMessage,
          history,
          toolContext,
          gitContext,
          signal,
          limits: { ...DEFAULT_LIMITS, budgetMs },
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
            // 记实际跑的那一个。selected 就是本次唯一跑过的模型 ——
            // 从这里取而不是从入参取,是为了让「库里记的」和「真跑的」
            // 在代码上是同一个来源,而不是两个碰巧相等的值。
            provider_id: selected.providerId,
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
            // 失败留痕同样记**实际跑的**那一个,与成功路径同源。
            // 两条路径取不同的来源,迟早会出现「同一次运行两个模型名」。
            provider_id: selected.providerId,
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
  await supabase
    .from("conversations")
    .update({ workspace_id: workspaceId })
    .eq("id", conversationId);

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
