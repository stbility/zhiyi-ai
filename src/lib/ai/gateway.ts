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

export interface ChatStreamResult {
  /** 逐段产出的文本增量 */
  readonly stream: AsyncGenerator<string, void, unknown>;
  /** 流结束后才有值 —— 用量通常在最后一个事件里 */
  readonly usage: ChatUsage;
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
    for await (const line of readSseLines(body)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") break;

      try {
        const chunk = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
          usage.outputTokens =
            chunk.usage.completion_tokens ?? usage.outputTokens;
        }

        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // 单个分片解析失败不应中断整个流 —— 上游偶尔会发送心跳或注释行
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

        if (event.type === "message_start") {
          usage.inputTokens = event.message?.usage?.input_tokens ?? null;
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

  const stream = await (credentials.kind === "anthropic"
    ? callAnthropic(credentials, model, messages, usage, signal)
    : credentials.kind === "google"
      ? callGoogle(credentials, model, messages, usage, signal)
      : callOpenAICompatible(credentials, model, messages, usage, signal));

  return { stream, usage };
}
