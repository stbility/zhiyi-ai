import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import {
  explainEmptyResponse,
  ProviderCallError,
  streamChat,
  type ChatMessage,
} from "@/lib/ai/gateway";
import type { ProviderKind } from "@/lib/providers/registry";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 流式对话接口。
 *
 * 数据流向:客户端 → 本路由 → 模型服务商 → 逐字回传客户端。
 * 密钥全程只在服务端出现,解密后立即用于请求,不写日志、不回传浏览器。
 *
 * 每次调用都会落库留痕:用了哪个 Provider、哪个模型、耗时、token 用量。
 * 失败同样落库并记下原因 —— 失败的调用也是发生过的事实,不能假装没发生。
 */

export const runtime = "nodejs";
// 流式响应不能被缓存
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().uuid().optional(),
  providerId: z.string().uuid("请选择模型服务"),
  model: z.string().trim().min(1, "请选择模型"),
  content: z.string().trim().min(1, "请输入内容").max(32_000, "内容过长"),
});

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return errorResponse("认证服务未配置。", 503);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return errorResponse("登录状态已失效,请重新登录。", 401);

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? "请求不合法", 400);
  }

  const { providerId, model, content } = parsed.data;

  // 读取 Provider —— 走用户身份客户端,RLS 保证只能读到自己组织的
  const { data: provider } = await supabase
    .from("ai_providers")
    .select("id, kind, base_url, api_key_cipher, organization_id, enabled")
    .eq("id", providerId)
    .maybeSingle();

  if (!provider) return errorResponse("未找到该模型服务。", 404);
  if (provider.enabled === false) {
    return errorResponse("该模型服务已停用。", 400);
  }

  const organizationId = provider.organization_id as string;

  // 找到或新建对话
  let conversationId = parsed.data.conversationId;
  if (!conversationId) {
    const { data: created, error } = await supabase
      .from("conversations")
      .insert({
        organization_id: organizationId,
        user_id: user.id,
        title: content.slice(0, 40),
      })
      .select("id")
      .single();

    if (error || !created) {
      return errorResponse("无法创建对话。", 500);
    }
    conversationId = created.id as string;
  }

  // 取历史消息作为上下文
  const { data: history } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(50);

  // 过滤掉内容为空的历史消息。
  //
  // 失败的调用会留下一条 content 为空的 assistant 记录(用于留痕),
  // 但 OpenAI 兼容接口不接受空内容的消息 —— 把它带进上下文会让之后
  // 每一轮都失败,故障自我传染。留痕归留痕,不能污染上下文。
  const messages: ChatMessage[] = [
    ...(history ?? [])
      .filter((m) => typeof m.content === "string" && m.content.trim() !== "")
      .map((m) => ({
        role: m.role as ChatMessage["role"],
        content: m.content as string,
      })),
    { role: "user" as const, content },
  ];

  // 先落库用户消息 —— 即便后续模型调用失败,用户说过的话也不该丢
  await supabase.from("messages").insert({
    conversation_id: conversationId,
    organization_id: organizationId,
    role: "user",
    content,
  });

  const startedAt = Date.now();
  const controller = new AbortController();
  // 客户端断开时同步中止上游请求,避免白白消耗配额
  request.signal.addEventListener("abort", () => controller.abort());

  let result;
  try {
    result = await streamChat({
      credentials: {
        kind: provider.kind as ProviderKind,
        baseUrl: (provider.base_url as string | null) ?? null,
        apiKeyCipher: provider.api_key_cipher as string,
      },
      model,
      messages,
      signal: controller.signal,
    });
  } catch (e) {
    const message =
      e instanceof ProviderCallError ? e.message : "调用模型服务失败。";

    // 失败也留痕
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

    return errorResponse(message, 502);
  }

  const encoder = new TextEncoder();
  const convId = conversationId;

  const body = new ReadableStream<Uint8Array>({
    async start(streamController) {
      let full = "";

      // 先把对话 id 告知客户端,便于后续消息挂到同一对话
      streamController.enqueue(
        encoder.encode(
          `event: meta\ndata: ${JSON.stringify({ conversationId: convId })}\n\n`,
        ),
      );

      try {
        for await (const delta of result.stream) {
          full += delta;
          streamController.enqueue(
            encoder.encode(
              `event: delta\ndata: ${JSON.stringify({ text: delta })}\n\n`,
            ),
          );
        }

        // 上游返回 200 却一个字都没产出 —— 这是失败,不是「成功但内容为空」。
        // 以前这里静默存成空消息,用户看到空气泡,数据库里也查不出原因。
        if (full === "") {
          const reason = explainEmptyResponse(result.diagnostics);

          await supabase.from("messages").insert({
            conversation_id: convId,
            organization_id: organizationId,
            role: "assistant",
            content: "",
            provider_id: providerId,
            model_id: model,
            latency_ms: Date.now() - startedAt,
            error_message: reason,
          });

          streamController.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ message: reason })}\n\n`,
            ),
          );
          return;
        }

        await supabase.from("messages").insert({
          conversation_id: convId,
          organization_id: organizationId,
          role: "assistant",
          content: full,
          provider_id: providerId,
          model_id: model,
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          latency_ms: Date.now() - startedAt,
        });

        streamController.enqueue(
          encoder.encode(
            `event: done\ndata: ${JSON.stringify({
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              latencyMs: Date.now() - startedAt,
            })}\n\n`,
          ),
        );
      } catch (e) {
        const message =
          e instanceof ProviderCallError
            ? e.message
            : "生成过程中断,请重试。";

        // 中断时把已生成的部分连同错误一起留痕,不丢用户已看到的内容
        await supabase.from("messages").insert({
          conversation_id: convId,
          organization_id: organizationId,
          role: "assistant",
          content: full,
          provider_id: providerId,
          model_id: model,
          latency_ms: Date.now() - startedAt,
          error_message: message,
        });

        streamController.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message })}\n\n`,
          ),
        );
      } finally {
        streamController.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 关闭反向代理缓冲,否则流会被攒着一次性发出,失去逐字效果
      "X-Accel-Buffering": "no",
    },
  });
}
