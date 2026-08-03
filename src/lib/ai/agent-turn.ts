import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_LIMITS,
  runAgent,
  summarizeRun,
  type AgentModelOption,
} from "@/lib/ai/agent";
import type { GitToolContext } from "@/lib/ai/git-tools";
import { listRepositories } from "@/lib/integrations/github";
import { logger } from "@/lib/log";
import type { AgentStep } from "@/lib/ai/agent";
import { ProviderCallError } from "@/lib/ai/gateway";
import type { ToolContext } from "@/lib/ai/tools";

/**
 * 智能体模式的一轮。
 *
 * 与普通问答分开成独立模块,而不是塞进对话路由里:两者的执行形态完全不同
 * (一个是单次流式生成,一个是多步工具循环),混在一个函数里会让两边都难改。
 *
 * 响应仍然是 SSE,但推的是**进度事件**而非逐字增量 ——
 * 用户需要看到的是「正在写 src/app.ts」,不是模型在想什么。
 */

/**
 * 候选池大小。
 *
 * 比对话路径的 3 个略多:智能体要跑十几步,每一步都可能撞上不同的服务商故障,
 * 多一个备选换来的是「前 10 步的产出不白费」。但也不能无限多 ——
 * 每个候选都要解一次密钥,而且候选越多,轮完一圈的时间就越长。
 */
const MAX_AGENT_CANDIDATES = 4;

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
}): Promise<Response> {
  // 工作区按需创建 —— 普通问答不需要,用到时才建,避免一堆空目录
  const workspaceId = await ensureWorkspace(
    supabase,
    organizationId,
    conversationId,
    userId,
  );

  const toolContext = createWorkspaceTools(
    supabase,
    workspaceId,
    organizationId,
    conversationId,
  );

  // Git 上下文。没连仓库就是 undefined —— 那种情况下根本不把仓库工具
  // 交给模型,而不是给了再拒绝:给一个必然失败的工具,模型会反复尝试
  // 并把有限的步数耗光。
  const gitContext = await loadGitContext(supabase, organizationId);

  // 候选模型:智能体一跑十几步,中途撞限流是常态。
  // 没有备用的话,第 11 步一个 503 就把前 10 步打死。
  //
  // 候选跨**整个组织的全部服务商**,不再限于用户选中的那一个。
  // 此前这里是 .eq("provider_id", providerId),于是英伟达容量塌陷时
  // 四个候选全在英伟达、全部超时,而用户配好的 DeepSeek 官方一次都没试过。
  // 凭据也必须跟着换 —— 拿 A 家的 key 调 B 家的模型只会得到 401。
  const { loadOrgCandidates, orderCandidates, createCredentialLoader } =
    await import("@/lib/ai/candidates");

  const ordered = orderCandidates(
    await loadOrgCandidates(supabase, organizationId),
    providerId,
    model,
  ).slice(0, MAX_AGENT_CANDIDATES);

  const credentialsFor = createCredentialLoader();
  const candidates: AgentModelOption[] = [];
  for (const c of ordered) {
    const creds = await credentialsFor(c);
    // 取不到密钥的候选直接不进候选池 —— 给一个必然 401 的候选,
    // 只会在每一步白烧一次往返
    if (!creds) {
      logger.warn(
        { providerId: c.providerId, organizationId },
        "候选服务商密钥不可读,已从候选池剔除",
      );
      continue;
    }
    candidates.push({
      providerId: c.providerId,
      providerName: c.providerName,
      modelId: c.modelId,
      credentials: creds,
    });
  }

  // 一个候选都没有:如实报错,而不是让循环空转到超时
  if (candidates.length === 0) {
    return new Response(
      JSON.stringify({
        error:
          "没有可用的模型服务。请到「模型服务」确认已添加服务商、密钥有效且模型已启用。",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

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

      send("meta", { conversationId, model, agent: true, workspaceId });

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

      try {
        const outcome = await runAgent({
          candidates,
          userMessage,
          history,
          toolContext,
          gitContext,
          signal,
          limits: DEFAULT_LIMITS,
          reporter: {
            onStep(step: AgentStep) {
              // 每一步都实时推给用户 —— 智能体跑几分钟,期间什么都不显示
              // 会让人以为卡死了
              send("step", {
                index: step.index,
                text: step.text,
                tools: step.tools.map((t) => ({
                  name: t.name,
                  ok: t.ok,
                  content: t.content.slice(0, 300),
                })),
              });
            },
          },
        });

        // 一个文件都没写,却输出了一大段像代码的正文 ——
        // 说明模型没理会工具,把代码贴在了回答里。这正是智能体模式要消灭的行为,
        // 必须明说,否则用户会以为是系统没保存。
        const wroteAnything = outcome.steps.some((s) =>
          s.tools.some((t) => t.name === "write_file" && t.ok),
        );
        const looksLikeCode = /```|function |const |import |class /.test(
          outcome.answer,
        );
        const summary =
          !wroteAnything && looksLikeCode
            ? summarizeRun(outcome) +
              "\n\n⚠️ 本次模型把代码写在了回答里,没有调用文件工具,因此工作区没有产物。" +
              "这通常是该模型对工具调用支持较弱 —— 换一个模型(GLM-5.2 或 deepseek-v4-pro)重试," +
              "或把任务说得更具体一些(例如「用 write_file 分别创建 A、B、C 三个文件」)。"
            : summarizeRun(outcome);

        // 取回 id:反馈按钮要用它。见 route.ts 的 insertAssistantMessage
        const { data: savedRow } = await supabase
          .from("messages")
          .insert({
            conversation_id: conversationId,
            organization_id: organizationId,
            role: "assistant",
            content: summary,
            provider_id: providerId,
            model_id: model,
            input_tokens: outcome.inputTokens,
            output_tokens: outcome.outputTokens,
            latency_ms: Date.now() - startedAt,
          })
          .select("id")
          .single();

        send("delta", { text: summary });
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
            provider_id: providerId,
            model_id: model,
            latency_ms: Date.now() - startedAt,
            error_message: message,
          });
        } catch {
          // 告知用户比留痕更要紧
        }

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
function createWorkspaceTools(
  supabase: SupabaseClient,
  workspaceId: string,
  organizationId: string,
  conversationId: string,
): ToolContext {
  return {
    async readFile(path) {
      const { data } = await supabase
        .from("workspace_files")
        .select("content")
        .eq("workspace_id", workspaceId)
        .eq("path", path)
        .maybeSingle();
      return (data?.content as string | undefined) ?? null;
    },

    async writeFile(path, content) {
      const { error } = await supabase.from("workspace_files").upsert(
        {
          workspace_id: workspaceId,
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
        .eq("workspace_id", workspaceId)
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
 * 装配 Git 工具上下文。
 *
 * **授权仓库列表实时从 GitHub 拉,不缓存在我们库里。**
 *
 * 这一点很要紧:用户随时可能在 GitHub 侧把某个仓库移出授权范围,
 * 甚至整个卸载应用。把列表缓存下来意味着我们会拿着一份过期的白名单
 * 继续放行 —— 虽然 GitHub 那边最终会拒绝,但我们在自己这一层就该
 * 反映真实的授权状态,而不是让用户看到一个已经无权访问的仓库还在列表里。
 *
 * 代价是每次智能体运行多一次 GitHub 往返。相对于「权限判断基于过期数据」
 * 这个风险,这点开销完全值得。
 */
async function loadGitContext(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<GitToolContext | undefined> {
  const { data } = await supabase
    .from("git_installations")
    .select("installation_id")
    .eq("organization_id", organizationId)
    .eq("provider", "github")
    .maybeSingle();

  const installationId = data?.installation_id as string | undefined;
  if (!installationId) return undefined;

  const repos = await listRepositories(installationId);
  if (!repos.ok) {
    logger.warn(
      { organizationId, reason: repos.error },
      "读取授权仓库列表失败,本轮不提供 Git 工具",
    );
    return undefined;
  }
  if (repos.repos.length === 0) return undefined;

  return {
    installationId,
    allowedRepos: repos.repos.map((r) => r.fullName),
    defaultBranches: Object.fromEntries(
      repos.repos.map((r) => [r.fullName, r.defaultBranch]),
    ),
  };
}
