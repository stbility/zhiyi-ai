import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import {
  explainEmptyResponse,
  ProviderCallError,
  streamChat,
  type ChatMessage,
} from "@/lib/ai/gateway";
import { createStallWatchdog } from "@/lib/ai/stall-watchdog";
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
// 显式声明,避免依赖平台默认值。Vercel 官方文档:Hobby 计划默认 300 秒、
// 上限同样是 300 秒,调不高。
// https://vercel.com/docs/functions/configuring-functions/duration
export const maxDuration = 300;

/**
 * 超时预算。
 *
 * 真实故障:三次失败落库的耗时分别是 296234 / 298105 / 296548 毫秒 ——
 * 全部贴着 300 秒。原因是网关对上游 fetch 没有任何超时,服务商排队不回应时
 * 就一直挂着,直到 Vercel 把函数强杀。函数被杀 = 连接被掐断,浏览器只能报
 * 「Failed to fetch」,用户完全不知道发生了什么。
 *
 * 所以必须在撞上限之前主动失败,把原因说清楚。
 */
/** 首个分片的等待上限 —— 超过说明服务商在排队或根本没响应 */
const FIRST_CHUNK_TIMEOUT_MS = 45_000;
/** 流中途卡住的上限 —— 已经在输出了,给宽一些 */
const STALL_TIMEOUT_MS = 60_000;
/** 总预算,留足余量给落库和收尾,绝不让平台来强杀 */
const TOTAL_BUDGET_MS = 240_000;

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

  // 看门狗同时承担两件事:客户端断开时中止上游(避免白白消耗配额),
  // 以及上游长时间不出内容时主动掐断(避免函数被平台强杀)。
  const watchdog = createStallWatchdog(
    TOTAL_BUDGET_MS,
    `本次调用已超过 ${Math.round(TOTAL_BUDGET_MS / 1000)} 秒仍未完成,已中止。请换一个更快的模型,或稍后重试。`,
    request.signal,
  );
  watchdog.arm(
    FIRST_CHUNK_TIMEOUT_MS,
    `模型在 ${Math.round(FIRST_CHUNK_TIMEOUT_MS / 1000)} 秒内没有返回任何内容,通常是该模型正在排队。请换一个模型,或稍后重试。`,
  );

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
      signal: watchdog.signal,
    });
  } catch (e) {
    watchdog.clear();

    // 看门狗掐断的,原因比上游抛出的 AbortError 有用得多
    const timedOut = watchdog.reason;
    if (timedOut !== null) {
      await supabase.from("messages").insert({
        conversation_id: conversationId,
        organization_id: organizationId,
        role: "assistant",
        content: "",
        provider_id: providerId,
        model_id: model,
        latency_ms: Date.now() - startedAt,
        error_message: timedOut,
      });
      return errorResponse(timedOut, 504);
    }

    // 客户端自己断开了,没人在等回复,不必再做什么
    if (request.signal.aborted) return errorResponse("请求已取消。", 499);

    const message =
      e instanceof ProviderCallError ? e.message : "调用模型服务失败。";

    // 如果失败原因是「这个模型压根不提供对话端点」,就把它从可选列表里摘掉。
    // 导入时的用途过滤只是启发式,总有漏网的;这里依据的是一次真实调用的结果,
    // 所以是可靠的一道 —— 同一个坑不该让用户踩第二次。
    const { indicatesModelUnusable } = await import(
      "@/lib/providers/model-filter"
    );
    if (
      indicatesModelUnusable(
        e instanceof ProviderCallError ? e.status : undefined,
        message,
      )
    ) {
      await supabase
        .from("ai_models")
        .update({ chat_unavailable_reason: message })
        .eq("provider_id", providerId)
        .eq("model_id", model);
    }

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

      // 客户端一旦断开(关页面、切走、网络掉线),enqueue/close 会抛
      // 「Invalid state」。这个抛出发生在 start() 里,会让整个函数以未处理异常
      // 收场 —— 服务端记成一次崩溃,后续的留痕代码也不再执行。
      // 客户端走掉是正常情况,不是服务端错误,所以这里全部吞掉。
      let clientGone = false;
      const send = (event: string, data: unknown) => {
        if (clientGone) return;
        try {
          streamController.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          clientGone = true;
        }
      };

      // 先把对话 id 告知客户端,便于后续消息挂到同一对话
      send("meta", { conversationId: convId });

      try {
        for await (const delta of result.stream) {
          full += delta;
          send("delta", { text: delta });
          // 有内容进来就重新计时 —— 只有「卡住不动」才该被掐断
          watchdog.arm(
            STALL_TIMEOUT_MS,
            `模型输出中途停滞超过 ${Math.round(STALL_TIMEOUT_MS / 1000)} 秒,已中止。上面是已生成的部分。`,
          );
        }
        watchdog.clear();

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

          send("error", { message: reason });
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

        send("done", {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          latencyMs: Date.now() - startedAt,
        });
      } catch (e) {
        // 看门狗掐断的,原因比 AbortError 有用得多
        const message =
          watchdog.reason ??
          (e instanceof ProviderCallError
            ? e.message
            : "生成过程中断,请重试。");

        // 中断时把已生成的部分连同错误一起留痕,不丢用户已看到的内容。
        // 留痕失败(比如连不上数据库)不能再把兜底路径本身炸掉 ——
        // 否则用户连错误提示都收不到,只会看到连接莫名断开。
        try {
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
        } catch {
          // 忽略:告知用户比留痕更要紧
        }

        send("error", { message });
      } finally {
        watchdog.clear();
        try {
          streamController.close();
        } catch {
          // 客户端已断开时 close 会抛,同样不算服务端错误
        }
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
