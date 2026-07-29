import "server-only";

import { decryptSecret } from "@/lib/crypto/secret-box";
import { getProviderSpec, type ProviderKind } from "@/lib/providers/registry";

/**
 * AI 模型网关。
 *
 * 业务代码只跟这里打交道,不认识任何具体服务商 —— 这是需求第四章的硬性要求:
 * 禁止把业务逻辑绑定到单一模型服务商。
 *
 * 各家协议差异在 Adapter 层消化:
 *   openai / openai_compatible —— OpenAI Chat Completions 协议,SSE 流式
 *   anthropic                  —— Messages 协议,事件名区分的 SSE
 *   google                     —— streamGenerateContent,JSON 数组流
 *
 * 每次调用都返回用量与耗时,由调用方落库。失败也要如实返回,不吞错。
 */

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ProviderCredentials {
  readonly kind: ProviderKind;
  readonly baseUrl: string | null;
  readonly apiKeyCipher: string;
}

export interface ChatUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * 一次调用的诊断信息。
 *
 * 上游返回 HTTP 200 却不产出任何内容时,光说「空回复」没有任何排查价值。
 * 这里记下它到底说了什么 —— finish_reason、流内错误、出现过哪些字段。
 */
export interface ChatDiagnostics {
  /** 上游给出的结束原因,如 stop / length / content_filter */
  finishReason: string | null;
  /** 流内返回的错误(HTTP 200 但载荷是错误时) */
  streamError: string | null;
  /** 分片中出现过的 delta 字段名,用于识别 reasoning_content 这类非标准字段 */
  seenDeltaKeys: string[];
  /** 收到的分片总数 */
  chunkCount: number;
}

export interface ChatStreamResult {
  /** 逐段产出的文本增量 */
  readonly stream: AsyncGenerator<string, void, unknown>;
  /** 流结束后才有值 —— 用量通常在最后一个事件里 */
  readonly usage: ChatUsage;
  /** 流结束后才有值 —— 用于解释「为什么没有内容」 */
  readonly diagnostics: ChatDiagnostics;
}

export class ProviderCallError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderCallError";
    this.status = status;
  }
}

function resolveBaseUrl(creds: ProviderCredentials): string {
  const spec = getProviderSpec(creds.kind);
  const base = creds.baseUrl ?? spec.defaultBaseUrl;
  if (!base) {
    throw new ProviderCallError("该模型服务缺少接口地址,无法调用。");
  }
  return base.replace(/\/+$/, "");
}

/**
 * 把上游的错误响应转成可读中文。
 * 只取状态码与简短原因 —— 响应体可能回显密钥,绝不原样透出。
 */
async function describeFailure(response: Response): Promise<string> {
  const status = response.status;
  if (status === 401 || status === 403) {
    return `密钥被拒绝(HTTP ${status}),请到「模型服务」检查密钥`;
  }
  if (status === 404) {
    return `接口或模型不存在(HTTP 404),请检查接口地址与模型名称`;
  }
  if (status === 429) {
    return "服务商限流,请稍后重试";
  }
  if (status >= 500) {
    return `服务商暂时不可用(HTTP ${status})`;
  }

  // 4xx 其它情况:尝试取上游给的 message 字段,它通常是安全的说明文字
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    const detail = body.error?.message;
    if (detail && detail.length < 200) return `HTTP ${status}:${detail}`;
  } catch {
    // 响应体不是 JSON,忽略
  }
  return `接口返回 HTTP ${status}`;
}

/** 逐行读取 SSE 流 */
async function* readSseLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // 最后一段可能不完整,留到下一轮
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed !== "") yield trimmed;
      }
    }
    if (buffer.trim() !== "") yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

/** OpenAI 及所有兼容接口 */
async function callOpenAICompatible(
  creds: ProviderCredentials,
  model: string,
  messages: readonly ChatMessage[],
  usage: ChatUsage,
  diagnostics: ChatDiagnostics,
  signal: AbortSignal,
): Promise<AsyncGenerator<string, void, unknown>> {
  const apiKey = decryptSecret(creds.apiKeyCipher);
  const response = await fetch(`${resolveBaseUrl(creds)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      // 请求上游在流末尾附带用量,兼容接口不支持时会忽略该字段
      stream_options: { include_usage: true },
    }),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new ProviderCallError(await describeFailure(response), response.status);
  }

  const body = response.body;

  return (async function* () {
    const keys = new Set<string>();

    for await (const line of readSseLines(body)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") break;

      let chunk: {
        choices?: {
          delta?: Record<string, unknown>;
          finish_reason?: string | null;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string } | string;
        message?: string;
        detail?: string;
      };

      try {
        chunk = JSON.parse(data);
      } catch {
        // 心跳或注释行,跳过
        continue;
      }

      diagnostics.chunkCount += 1;

      // 上游可能以 HTTP 200 返回,把错误塞在流里。以前这里被静默吞掉,
      // 表现就是「空回复且无错误」—— 排查时毫无线索。现在直接中断并报出。
      const streamError =
        typeof chunk.error === "string"
          ? chunk.error
          : (chunk.error?.message ?? chunk.detail ?? null);
      if (streamError) {
        diagnostics.streamError = streamError;
        throw new ProviderCallError(translateUpstreamError(streamError));
      }

      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
        usage.outputTokens =
          chunk.usage.completion_tokens ?? usage.outputTokens;
      }

      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) {
        diagnostics.finishReason = choice.finish_reason;
      }

      const delta = choice?.delta;
      if (delta) {
        for (const k of Object.keys(delta)) keys.add(k);
        diagnostics.seenDeltaKeys = [...keys];

        // 推理类模型把思考过程放在 reasoning_content,最终答案仍在 content。
        // 只产出 content —— 思考过程不应混进给用户看的回答里。
        const text = delta["content"];
        if (typeof text === "string" && text !== "") yield text;
      }
    }
  })();
}

/** Anthropic Messages 协议 */
async function callAnthropic(
  creds: ProviderCredentials,
  model: string,
  messages: readonly ChatMessage[],
  usage: ChatUsage,
  diagnostics: ChatDiagnostics,
  signal: AbortSignal,
): Promise<AsyncGenerator<string, void, unknown>> {
  const apiKey = decryptSecret(creds.apiKeyCipher);

  // Anthropic 的 system 提示是独立字段,不放在 messages 里
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");

  const response = await fetch(`${resolveBaseUrl(creds)}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      stream: true,
      ...(system === "" ? {} : { system }),
      messages: rest,
    }),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new ProviderCallError(await describeFailure(response), response.status);
  }

  const body = response.body;

  return (async function* () {
    for await (const line of readSseLines(body)) {
      if (!line.startsWith("data:")) continue;

      try {
        const event = JSON.parse(line.slice(5).trim()) as {
          type?: string;
          delta?: { text?: string };
          message?: { usage?: { input_tokens?: number } };
          usage?: { output_tokens?: number };
        };

        diagnostics.chunkCount += 1;

        if (event.type === "message_start") {
          usage.inputTokens = event.message?.usage?.input_tokens ?? null;
        }
        if (event.type === "error") {
          const detail = "Anthropic 返回流内错误";
          diagnostics.streamError = detail;
          throw new ProviderCallError(detail);
        }
        if (event.type === "message_delta") {
          usage.outputTokens = event.usage?.output_tokens ?? usage.outputTokens;
        }
        if (event.type === "content_block_delta" && event.delta?.text) {
          yield event.delta.text;
        }
      } catch {
        // 同上,单条事件解析失败不中断流
      }
    }
  })();
}

/** Google Generative Language */
async function callGoogle(
  creds: ProviderCredentials,
  model: string,
  messages: readonly ChatMessage[],
  usage: ChatUsage,
  diagnostics: ChatDiagnostics,
  signal: AbortSignal,
): Promise<AsyncGenerator<string, void, unknown>> {
  const apiKey = decryptSecret(creds.apiKeyCipher);

  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      // Google 用 model 表示助手角色
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const url =
    `${resolveBaseUrl(creds)}/models/${encodeURIComponent(model)}` +
    `:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      ...(systemText === ""
        ? {}
        : { systemInstruction: { parts: [{ text: systemText }] } }),
    }),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new ProviderCallError(await describeFailure(response), response.status);
  }

  const body = response.body;

  return (async function* () {
    for await (const line of readSseLines(body)) {
      if (!line.startsWith("data:")) continue;

      try {
        const chunk = JSON.parse(line.slice(5).trim()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
          usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
          };
        };

        diagnostics.chunkCount += 1;

        if (chunk.usageMetadata) {
          usage.inputTokens =
            chunk.usageMetadata.promptTokenCount ?? usage.inputTokens;
          usage.outputTokens =
            chunk.usageMetadata.candidatesTokenCount ?? usage.outputTokens;
        }

        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) yield text;
      } catch {
        // 同上
      }
    }
  })();
}

/**
 * 发起一次流式对话。
 *
 * 调用方负责:落库消息、记录用量与耗时、把错误如实呈现给用户。
 * 本函数不吞任何错误 —— 失败一律抛 ProviderCallError。
 */
export async function streamChat({
  credentials,
  model,
  messages,
  signal,
}: {
  credentials: ProviderCredentials;
  model: string;
  messages: readonly ChatMessage[];
  signal: AbortSignal;
}): Promise<ChatStreamResult> {
  const usage: ChatUsage = { inputTokens: null, outputTokens: null };
  const diagnostics: ChatDiagnostics = {
    finishReason: null,
    streamError: null,
    seenDeltaKeys: [],
    chunkCount: 0,
  };

  const stream = await (credentials.kind === "anthropic"
    ? callAnthropic(credentials, model, messages, usage, diagnostics, signal)
    : credentials.kind === "google"
      ? callGoogle(credentials, model, messages, usage, diagnostics, signal)
      : callOpenAICompatible(
          credentials,
          model,
          messages,
          usage,
          diagnostics,
          signal,
        ));

  return { stream, usage, diagnostics };
}

/** 一次模型可用性探测的结果 */
export interface ModelProbeResult {
  readonly model: string;
  readonly ok: boolean;
  /** 失败时的原因,已翻译成可读中文;成功时为 null */
  readonly reason: string | null;
  readonly latencyMs: number;
}

/**
 * 用一次真实对话确认模型确实能工作。
 *
 * 为什么必须真调一次:服务商的 /models 只说明「这个账号能看到该模型」,
 * 不说明它能对话。此前把整个列表无差别导入,用户选中嵌入模型就是 404;
 * 而即便是货真价实的对话模型,也可能因为容量、权限、下线而调不通。
 * 「能不能用」只有调过才知道 —— 这正是用户要求的「不要写伪模型」。
 *
 * 探测刻意做得极小:一句话、几个 token,成本可以忽略。
 */
export async function probeChatModel({
  credentials,
  model,
  timeoutMs,
}: {
  credentials: ProviderCredentials;
  model: string;
  timeoutMs: number;
}): Promise<ModelProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { stream, diagnostics } = await streamChat({
      credentials,
      model,
      messages: [{ role: "user", content: "你好" }],
      signal: controller.signal,
    });

    let text = "";
    for await (const delta of stream) {
      text += delta;
      // 收到内容就够了 —— 探测不需要等模型说完
      if (text.trim() !== "") break;
    }

    const latencyMs = Date.now() - startedAt;
    if (text.trim() === "") {
      return {
        model,
        ok: false,
        reason: explainEmptyResponse(diagnostics),
        latencyMs,
      };
    }
    return { model, ok: true, reason: null, latencyMs };
  } catch (e) {
    const latencyMs = Date.now() - startedAt;
    if (controller.signal.aborted) {
      return {
        model,
        ok: false,
        reason: `探测超过 ${Math.round(timeoutMs / 1000)} 秒未返回,通常是该模型正在排队`,
        latencyMs,
      };
    }
    return {
      model,
      ok: false,
      reason:
        e instanceof ProviderCallError
          ? e.message
          : e instanceof Error
            ? e.message
            : "调用失败",
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
    // 探测拿到内容就走,剩下的流不再需要,主动中止省配额
    controller.abort();
  }
}


/**
 * 把「上游返回了 200 却没有任何内容」翻译成可排查的说明。
 *
 * 这种情况以前被当成「成功但内容为空」存了下来,用户看到一个空气泡,
 * 数据库里也没有任何线索。现在必须给出原因。
 */
export function explainEmptyResponse(d: ChatDiagnostics): string {
  if (d.streamError) return translateUpstreamError(d.streamError);

  if (d.chunkCount === 0) {
    return "模型没有返回任何数据。可能是该模型当前不可用,或不支持流式输出。";
  }

  switch (d.finishReason) {
    case "length":
      return "输出长度达到上限,模型未能给出内容。请缩短输入后重试。";
    case "content_filter":
      return "内容被模型的安全策略拦截,未产生回复。";
    default:
      break;
  }

  // 推理类模型只吐了思考过程、没有最终答案时,字段名是关键线索
  if (
    d.seenDeltaKeys.includes("reasoning_content") &&
    !d.seenDeltaKeys.includes("content")
  ) {
    return "该模型本次只输出了推理过程、没有给出最终回答。换一个模型或重试通常可解决。";
  }

  const keys = d.seenDeltaKeys.length > 0 ? d.seenDeltaKeys.join("、") : "无";
  return `模型返回了 ${d.chunkCount} 个数据分片,但其中没有正文内容(出现的字段:${keys})。`;
}


/**
 * 把服务商的英文技术错误翻译成用户能据以行动的中文。
 *
 * 例如 NVIDIA 的
 *   ResourceExhausted: Worker local total request limit reached (3228/48)
 * 直接抛给用户毫无意义 —— 它的实际含义是「这个模型此刻排队爆满」,
 * 用户该做的是换个模型或稍后再试。
 *
 * 无法识别的错误保留原文,不粉饰、不吞掉。
 */
export function translateUpstreamError(raw: string): string {
  const text = raw.trim();

  if (/resourceexhausted|request limit reached|out of capacity/i.test(text)) {
    return "该模型当前排队已满,服务商暂时无法接收新请求。请换一个模型,或稍后再试。";
  }
  if (/rate.?limit|too many requests|429/i.test(text)) {
    return "调用过于频繁,已被服务商限流。请稍等片刻再试。";
  }
  if (/context length|maximum context|token limit|too long/i.test(text)) {
    return "对话内容超出该模型的上下文长度上限。请新开一个对话,或缩短输入。";
  }
  if (/model.*(not found|does not exist|unavailable)/i.test(text)) {
    return "该模型不存在或已下线。请到「模型服务」重新测试连接以刷新模型列表。";
  }
  if (/unauthorized|invalid.*api.?key|authentication/i.test(text)) {
    return "密钥被拒绝。请到「模型服务」检查密钥是否正确或已过期。";
  }
  if (/insufficient|quota|billing|credit/i.test(text)) {
    return "服务商账户额度不足。请检查该账户的余额或配额。";
  }

  // 未收录:保留原文,让用户能据此去服务商侧排查
  return `模型返回错误:${text}`;
}
