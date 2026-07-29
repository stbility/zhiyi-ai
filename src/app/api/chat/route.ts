import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import {
  explainEmptyResponse,
  ProviderCallError,
  streamChat,
  type ChatMessage,
} from "@/lib/ai/gateway";
import { buildFallbackChain, describeFallback } from "@/lib/ai/fallback";
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
/**
 * 一次请求最多换几个模型。
 *
 * 排队时自动降级是「长期稳定执行任务」的关键,但不能无限换 —— 总预算是
 * 共享的,换太多次只会让用户干等到超时,还不如早点如实报错。
 */
const MAX_MODEL_ATTEMPTS = 3;

const bodySchema = z.object({
  conversationId: z.string().uuid().optional(),
  providerId: z.string().uuid("请选择模型服务"),
  model: z.string().trim().min(1, "请选择模型"),
  content: z.string().trim().min(1, "请输入内容").max(32_000, "内容过长"),
  /**
   * 本轮附带的项目文件。
   *
   * 单独成一个字段而不是拼进 content:用户自己打的字要保持可读、可回看,
   * 附件是另一回事。上限在服务端再校验一次 —— 浏览器侧的限制随时可以绕过。
   */
  attachments: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(400),
        content: z.string().max(400_000),
      }),
    )
    .optional()
    // 不限文件个数,只约束总量 —— 真实项目动辄上千个文件,
    // 卡个数只会把源码截断。总量上限来自请求体大小这个物理约束。
    .refine(
      (list) =>
        (list ?? []).reduce((n, a) => n + a.content.length, 0) <= 1_200_000,
      { message: "附件总量超过上限,请选择更小的目录" },
    ),
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

  // 限流。放在最前面 —— 越早拒绝,越少浪费。
  //
  // 这是整个系统里唯一会造成直接金钱损失的缺口:此前只校验登录,
  // 一个循环脚本就能把用户配置的服务商配额刷干,账单落在用户头上。
  const { checkRateLimit } = await import("@/lib/services/rate-limit");
  const limit = await checkRateLimit(`chat:${user.id}`);
  if (!limit.allowed) {
    return errorResponse(limit.reason ?? "请求过于频繁,请稍后再试。", 429);
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
  // 附件拼在本轮用户消息前面,并标明路径 —— 模型需要知道每段代码在项目里的位置。
  // 只作用于本轮:附件正文不落库,否则每条历史消息都背着几十 KB 代码,
  // 上下文很快就被自己撑爆了。界面上会说明这一点。
  const attachments = parsed.data.attachments ?? [];
  const attachmentBlock =
    attachments.length === 0
      ? ""
      : `以下是用户附带的项目文件,供你参考(共 ${attachments.length} 个):\n\n` +
        attachments
          .map((a) => `--- ${a.path} ---\n${a.content}`)
          .join("\n\n") +
        "\n\n---\n\n";

  const messages: ChatMessage[] = [
    ...(history ?? [])
      .filter((m) => typeof m.content === "string" && m.content.trim() !== "")
      .map((m) => ({
        role: m.role as ChatMessage["role"],
        content: m.content as string,
      })),
    { role: "user" as const, content: `${attachmentBlock}${content}` },
  ];

  // 先落库用户消息 —— 即便后续模型调用失败,用户说过的话也不该丢。
  // 存的是用户自己打的字,不含附件正文。
  await supabase.from("messages").insert({
    conversation_id: conversationId,
    organization_id: organizationId,
    role: "user",
    content,
  });

  const startedAt = Date.now();
  const credentials = {
    kind: provider.kind as ProviderKind,
    baseUrl: (provider.base_url as string | null) ?? null,
    apiKeyCipher: provider.api_key_cipher as string,
  };

  // 取当前可选模型,排出降级链。
  //
  // 用户要的是「长期稳定执行任务」,而共享算力上的模型排队是常态,不是故障。
  // 稳定不能靠挑一个永不排队的模型(不存在),只能靠排队时自动换一个。
  const { data: availableRows } = await supabase
    .from("ai_models")
    .select("model_id")
    .eq("provider_id", providerId)
    .eq("enabled", true)
    .is("chat_unavailable_reason", null);

  const chain = buildFallbackChain(
    (availableRows ?? []).map((r) => r.model_id as string),
    model,
  ).slice(0, MAX_MODEL_ATTEMPTS);

  const { indicatesModelUnusable, isTransientFailure } = await import(
    "@/lib/providers/model-filter"
  );

  let result: Awaited<ReturnType<typeof streamChat>> | null = null;
  let watchdog: ReturnType<typeof createStallWatchdog> | null = null;
  /** 实际用上的模型,可能不是用户选的那个 */
  let actualModel = model;
  /** 降级说明。发生了就必须告诉用户 —— 悄悄换模型等于伪造来源 */
  let fallbackNote: string | null = null;
  let lastFailure = "调用模型服务失败。";
  let lastStatus: number | undefined;

  for (const candidate of chain) {
    // 总预算是整次请求共享的,不是每个模型各给一份 —— 否则四个模型轮下来
    // 早就撞上平台的函数时限了
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < FIRST_CHUNK_TIMEOUT_MS) break;

    const wd = createStallWatchdog(
      remaining,
      `本次调用已超过 ${Math.round(TOTAL_BUDGET_MS / 1000)} 秒仍未完成,已中止。请稍后重试。`,
      request.signal,
    );
    wd.arm(
      FIRST_CHUNK_TIMEOUT_MS,
      `模型在 ${Math.round(FIRST_CHUNK_TIMEOUT_MS / 1000)} 秒内没有返回任何内容,通常是该模型正在排队。`,
    );

    try {
      result = await streamChat({
        credentials,
        model: candidate,
        messages,
        signal: wd.signal,
      });
      watchdog = wd;
      actualModel = candidate;
      if (candidate !== model) {
        fallbackNote = describeFallback(model, candidate, lastFailure);
      }
      break;
    } catch (e) {
      wd.clear();

      // 客户端自己断开了,没人在等回复,换模型重试毫无意义
      if (request.signal.aborted) return errorResponse("请求已取消。", 499);

      lastStatus = e instanceof ProviderCallError ? e.status : undefined;
      lastFailure =
        wd.reason ??
        (e instanceof ProviderCallError ? e.message : "调用模型服务失败。");

      // 只记录失败原因,不再把模型从可选列表里摘掉。
      //
      // 早先是「永久性失败即标记不可用」,结果把用户真正需要的模型悄悄拿走了 ——
      // Kimi 就是这种情况:服务商目录里有、代理编程要用,只是这个账号
      // 暂时没被授权。系统不该替用户做这个决定。
      // 本次调用会由下面的降级链换一个模型完成,任务不中断。
      if (indicatesModelUnusable(lastStatus, lastFailure)) {
        await supabase
          .from("ai_models")
          .update({ last_error: lastFailure })
          .eq("provider_id", providerId)
          .eq("model_id", candidate);
      }
      // 继续尝试链上的下一个模型
    }
  }

  if (result === null || watchdog === null) {
    // 全链路都没成功。留痕时记的是用户原本选的模型 —— 那才是他的意图。
    const message =
      chain.length > 1
        ? `${lastFailure}(已依次尝试 ${chain.length} 个模型:${chain.join("、")})`
        : lastFailure;

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

    return errorResponse(
      message,
      isTransientFailure(lastStatus, lastFailure) ? 504 : 502,
    );
  }

  // 收窄成 const,闭包里才拿得到非空类型
  const chosen = result;
  const wd = watchdog;
  const usedModel = actualModel;
  const note = fallbackNote;

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

      // 先把对话 id 告知客户端,便于后续消息挂到同一对话。
      // 若发生了降级,一并说明用的其实是哪个模型 —— 悄悄换等于伪造来源。
      send("meta", { conversationId: convId, model: usedModel, ...(note ? { fallback: note } : {}) });

      try {
        for await (const delta of chosen.stream) {
          full += delta;
          send("delta", { text: delta });
          // 有内容进来就重新计时 —— 只有「卡住不动」才该被掐断
          wd.arm(
            STALL_TIMEOUT_MS,
            `模型输出中途停滞超过 ${Math.round(STALL_TIMEOUT_MS / 1000)} 秒,已中止。上面是已生成的部分。`,
          );
        }
        wd.clear();

        // 上游返回 200 却一个字都没产出 —— 这是失败,不是「成功但内容为空」。
        // 以前这里静默存成空消息,用户看到空气泡,数据库里也查不出原因。
        if (full === "") {
          const reason = explainEmptyResponse(chosen.diagnostics);

          await supabase.from("messages").insert({
            conversation_id: convId,
            organization_id: organizationId,
            role: "assistant",
            content: "",
            provider_id: providerId,
            model_id: usedModel,
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
          model_id: usedModel,
          input_tokens: chosen.usage.inputTokens,
          output_tokens: chosen.usage.outputTokens,
          latency_ms: Date.now() - startedAt,
        });

        // 这次真的成功了,清掉上次的失败留痕 ——
        // 否则一条早已过时的报错会一直挂在模型旁边,与事实相反。
        await supabase
          .from("ai_models")
          .update({ last_error: null })
          .eq("provider_id", providerId)
          .eq("model_id", usedModel);

        send("done", {
          inputTokens: chosen.usage.inputTokens,
          outputTokens: chosen.usage.outputTokens,
          latencyMs: Date.now() - startedAt,
        });
      } catch (e) {
        // 看门狗掐断的,原因比 AbortError 有用得多
        const message =
          wd.reason ??
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
            model_id: usedModel,
            latency_ms: Date.now() - startedAt,
            error_message: message,
          });
        } catch {
          // 忽略:告知用户比留痕更要紧
        }

        send("error", { message });
      } finally {
        wd.clear();
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
