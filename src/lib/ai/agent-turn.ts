import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { DEFAULT_LIMITS, runAgent, summarizeRun } from "@/lib/ai/agent";
import type { AgentStep } from "@/lib/ai/agent";
import { ProviderCallError } from "@/lib/ai/gateway";
import type { ProviderCredentials } from "@/lib/ai/gateway";
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

export async function runAgentTurn({
  supabase,
  userId,
  organizationId,
  conversationId,
  providerId,
  model,
  credentials,
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
  credentials: ProviderCredentials;
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

      try {
        const outcome = await runAgent({
          credentials,
          model,
          userMessage,
          history,
          toolContext,
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

        const summary = summarizeRun(outcome);

        await supabase.from("messages").insert({
          conversation_id: conversationId,
          organization_id: organizationId,
          role: "assistant",
          content: summary,
          provider_id: providerId,
          model_id: model,
          input_tokens: outcome.inputTokens,
          output_tokens: outcome.outputTokens,
          latency_ms: Date.now() - startedAt,
        });

        send("delta", { text: summary });
        send("done", {
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
          latencyMs: Date.now() - startedAt,
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
