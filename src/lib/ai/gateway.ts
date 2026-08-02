import "server-only";

import { decryptSecret } from "@/lib/crypto/secret-box";
import { isTransientFailure } from "@/lib/providers/model-filter";
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

/**
 * 流里的一个增量。
 *
 * 必须区分正文与思考过程,不能都当字符串往外吐:
 *   content   —— 给用户的答案,要计入最终存库的正文
 *   reasoning —— 推理模型的思考过程,要实时显示但不属于答案
 *
 * 此前思考过程被整段缓冲、只在「完全没有正文」时才吐出来。后果有二:
 *   1. 模型思考的几分钟里前端一个字都收不到,界面看起来是死的
 *   2. 看门狗只在收到增量时重新计时 —— 推理模型正常工作却被判定
 *      「45 秒没有返回任何内容」而掐断
 */
export interface StreamChunk {
  readonly kind: "content" | "reasoning";
  readonly text: string;
}

export interface ChatStreamResult {
  /** 逐段产出的增量,区分正文与思考过程 */
  readonly stream: AsyncGenerator<StreamChunk, void, unknown>;
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
/**
 * 从上游响应体里取出可读的错误说明。
 *
 * 各家结构不一:OpenAI 兼容用 error.message,NVIDIA 有时用 detail 或 title,
 * 有的直接给纯文本。取不到就算了,但绝不能不取 —— 上游的原话往往是唯一
 * 能说清「到底哪里不对」的线索。
 *
 * 安全:只取说明文字,且做长度截断与疑似密钥擦除。响应体理论上可能回显
 * 请求内容,而请求头里有密钥。
 */
async function readUpstreamDetail(response: Response): Promise<string | null> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.trim() === "") return null;

  let detail: string | null = null;
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string } | string;
      detail?: string;
      message?: string;
      title?: string;
    };
    detail =
      (typeof body.error === "string" ? body.error : body.error?.message) ??
      body.detail ??
      body.message ??
      body.title ??
      null;
  } catch {
    // 不是 JSON,当纯文本用
    detail = text;
  }

  if (!detail) return null;

  // 擦掉任何形似密钥的串,再截断。宁可少说,不可泄密。
  const safe = detail
    .replace(/\b(nvapi|sk|pk|key)[-_][A-Za-z0-9_-]{8,}/gi, "[已隐去]")
    // 账号标识与内部函数 ID 对用户毫无意义,只会让报错更吓人。
    // 英伟达的原话形如
    //   Function '23d4f03a-…': Not found for account 'AOVVcakqua2…'
    // 那串 UUID 是它内部的函数编号,那串 account 是账号指纹 —— 都删掉,
    // 剩下的「Not found for account」才是真正有信息量的部分。
    .replace(/\bFunction\s+'[0-9a-f-]{16,}'\s*:?\s*/gi, "")
    .replace(/\baccount\s+'[A-Za-z0-9_-]{16,}'/gi, "account")
    .replace(/\s+/g, " ")
    .trim();

  return safe === "" ? null : safe.slice(0, 240);
}

/**
 * 「不是写错了,是没开通」的原话特征。
 *
 * 按语义匹配而不是认厂商 —— 各家措辞不同但意思一样,写死某一家的话,
 * 换个服务商就又回到误导性诊断。
 */
const NO_ENTITLEMENT =
  /not found for account|not authorized|no access to|not entitled|access denied|无权限|未开通|没有权限/i;

/** 导出仅为可测试 —— 错误诊断的措辞直接决定用户去修哪里,必须能被守住 */
export async function describeFailure(
  response: Response,
  /** 出错的模型标识。多个模型并存时不点名等于没说 */
  model?: string,
): Promise<string> {
  const status = response.status;
  const who = model ? `模型 ${model}:` : "";
  // 先把上游原话取出来 —— 之前对 401/403/404/429/5xx 直接返回固定文案,
  // 根本没读响应体,上游对失败的真正解释被整个丢掉。
  // 真实教训:moonshotai/kimi-k2.6 的模型标识与端点都和官方文档一致却报 404,
  // 而我们除了「模型不存在」什么都说不出来,根本无从排查。
  const detail = await readUpstreamDetail(response);
  const suffix = detail ? `。服务商原话:${detail}` : "";

  if (status === 401 || status === 403) {
    // 403 + Authorization failed 是一种很具体的情况,值得单独说清楚:
    // 密钥本身有效(能列出模型列表),但账号没有开通「调用推理端点」的权限。
    // 官方论坛上这一条记录得很清楚 —— 同一把密钥 GET /v1/models 成功、
    // POST /v1/chat/completions 返回 403,原因是组织缺少
    // "Public API Endpoints" 权限,而且用户自己在控制台改不了,要联系服务商开通。
    //
    // 不说清楚的话,用户只会反复换密钥 —— 换多少次都是同样的 403。
    if (status === 403 && /authorization failed/i.test(detail ?? "")) {
      // 这条 403 有两种常见成因,而且都不是「密钥填错了」,
      // 所以不能只说一句「请检查密钥」——那会让人反复重填同一把死钥匙。
      //
      // 最常见的是**密钥已被吊销或轮换**:控制台里删掉旧密钥后,
      // 系统里存的那把立刻变成这个 403。这是实际发生过的情况。
      //
      // 少数情况是账号缺少调用推理端点的权限(NVIDIA 称作
      // Public API Endpoints),特征是同一把密钥能列出模型列表却不能对话。
      // 这种要联系服务商开通,换密钥没用。
      //
      // 两种都列出来,让用户自己对号入座 —— 比替他猜一个更有用。
      return (
        `${who}服务商拒绝了这次调用(HTTP 403)。常见原因有两种:\n` +
        `1. 密钥已被吊销或轮换 —— 在服务商控制台删过旧密钥的话,` +
        `系统里存的这把就失效了,到「模型服务」重新填一把新的即可;\n` +
        `2. 账号没有调用推理端点的权限 —— 特征是同一把密钥能列出模型列表` +
        `却不能发起对话,这种要联系服务商开通,换密钥无效${suffix}`
      );
    }
    return `${who}密钥被拒绝(HTTP ${status}),请到「模型服务」检查密钥${suffix}`;
  }
  if (status === 404) {
    // 404 有两种截然不同的成因,给错诊断比不给更糟。
    //
    // 一种是真的写错了(地址拼错、模型名打错)。
    // 另一种是**账号没有开通这个模型** —— 标识和地址都对,服务商也在
    // /models 里把它列了出来,但这个账号没有调用权限。英伟达对后者返回的
    // 原话是「Not found for account …」,状态码同样是 404。
    //
    // 此前两种一律回一句「请检查接口地址与模型名称」,把用户支使去改
    // 一个根本没坏的地方,真正该做的事(去服务商控制台开通)一个字没提。
    if (NO_ENTITLEMENT.test(detail ?? "")) {
      return (
        `${who}该模型在你的服务商账号下没有调用权限(HTTP 404)。` +
        `模型标识与接口地址都没有问题 —— 这是账号侧的开通问题,` +
        `需要到服务商控制台申请开通该模型,或先改用其它模型${suffix}`
      );
    }
    return `${who}接口或模型不存在(HTTP 404),请检查接口地址与模型名称${suffix}`;
  }
  if (status === 429) {
    return `${who}服务商限流,请稍后重试${suffix}`;
  }
  if (status >= 500) {
    return `${who}服务商暂时不可用(HTTP ${status})${suffix}`;
  }
  return detail ? `${who}HTTP ${status}:${detail}` : `${who}接口返回 HTTP ${status}`;
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
): Promise<AsyncGenerator<StreamChunk, void, unknown>> {
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
    throw new ProviderCallError(await describeFailure(response, model), response.status);
  }

  const body = response.body;

  return (async function* () {
    const keys = new Set<string>();
    /** 本轮是否产出过正文 */
    let emittedContent = false;
    /** 思考过程。只有在完全没有正文时才交给用户,并标明它是什么 */
    let reasoningBuffer = "";

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

        // 推理类模型把思考过程放在 reasoning_content,最终答案在 content。
        // 正常情况下只产出 content —— 思考过程不该混进给用户看的回答里。
        const text = delta["content"];
        if (typeof text === "string" && text !== "") {
          emittedContent = true;
          yield { kind: "content", text } as const;
        }

        // 但也要把思考过程留着。有些推理模型(英伟达上的 deepseek-v4-pro
        // 这类)在未关闭 thinking 时,整轮可能只吐 reasoning_content 而
        // content 始终为空 —— 此前这会被判成「返回 200 却没有内容」,
        // 用户看到一个空气泡,而模型其实是有输出的,只是放在了另一个字段。
        //
        // 字段名 reasoning_content 是 DeepSeek 与英伟达等多家共用的约定,
        // 这里按字段判断,不按服务商判断。
        const reasoning = delta["reasoning_content"];
        if (typeof reasoning === "string" && reasoning !== "") {
          reasoningBuffer += reasoning;
          // 实时吐出去。它不是答案,但它证明模型正在工作 ——
          // 前端据此显示「思考中」,看门狗据此知道没有卡住。
          yield { kind: "reasoning", text: reasoning } as const;
        }
      }
    }

    // 整轮下来一个字的正文都没有,但有思考过程 —— 把它交出来,并说明这是什么。
    // 给出模型真实产生的内容,比报一句「没有内容」有用得多。
    if (!emittedContent && reasoningBuffer !== "") {
      yield {
        kind: "content",
        text: `(本轮没有产出正式回答,以下是模型的思考过程)\n\n${reasoningBuffer}`,
      } as const;
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
): Promise<AsyncGenerator<StreamChunk, void, unknown>> {
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
    throw new ProviderCallError(await describeFailure(response, model), response.status);
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
          yield { kind: "content", text: event.delta.text } as const;
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
): Promise<AsyncGenerator<StreamChunk, void, unknown>> {
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
    throw new ProviderCallError(await describeFailure(response, model), response.status);
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
        if (text) yield { kind: "content", text } as const;
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
  /**
   * 失败是否属于「等一会儿就好」。
   *
   * 这个字段决定模型的去留:临时故障只是此刻排不上队,模型本身好好的,
   * 绝不能因此被永久剔除;永久故障(模型下线、不提供对话端点)才该剔除。
   * 成功时为 false。
   */
  readonly transient: boolean;
  /** 实际尝试了几次 */
  readonly attempts: number;
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
 *
 * 临时性失败(排队、限流、超时)会重试 —— 一次堵车不该决定一条路的存废。
 * 真实教训:deepseek-v4-flash 与 deepseek-v4-pro 都是因为一次排队就被
 * 永久标记为不可用,用户从此在列表里再也看不到 DeepSeek。
 */
export async function probeChatModel({
  credentials,
  model,
  timeoutMs,
  attempts = 3,
  backoffMs = 1_500,
}: {
  credentials: ProviderCredentials;
  model: string;
  timeoutMs: number;
  /** 最多尝试几次(仅临时性失败才重试) */
  attempts?: number;
  /** 首次重试前的等待,之后翻倍 */
  backoffMs?: number;
}): Promise<ModelProbeResult> {
  const startedAt = Date.now();
  let last: Omit<ModelProbeResult, "attempts"> | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await probeOnce(credentials, model, timeoutMs, startedAt);
    if (result.ok) return { ...result, attempts: attempt };

    last = result;
    // 永久性失败没有重试的意义 —— 模型下线了,再试一百次还是下线
    if (!result.transient || attempt === attempts) break;

    await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
  }

  return {
    ...(last ?? {
      model,
      ok: false,
      reason: "调用失败",
      latencyMs: Date.now() - startedAt,
      transient: true,
    }),
    attempts,
  };
}

/** 单次探测,不含重试 */
async function probeOnce(
  credentials: ProviderCredentials,
  model: string,
  timeoutMs: number,
  startedAt: number,
): Promise<Omit<ModelProbeResult, "attempts">> {
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
      const reason = explainEmptyResponse(diagnostics);
      return {
        model,
        ok: false,
        reason,
        latencyMs,
        transient: isTransientFailure(undefined, reason),
      };
    }
    return { model, ok: true, reason: null, latencyMs, transient: false };
  } catch (e) {
    const latencyMs = Date.now() - startedAt;
    if (controller.signal.aborted) {
      return {
        model,
        ok: false,
        reason: `探测超过 ${Math.round(timeoutMs / 1000)} 秒未返回,通常是该模型正在排队`,
        latencyMs,
        // 超时就是排队的典型表现,是容量问题不是模型问题
        transient: true,
      };
    }
    const status = e instanceof ProviderCallError ? e.status : undefined;
    const reason =
      e instanceof ProviderCallError
        ? e.message
        : e instanceof Error
          ? e.message
          : "调用失败";
    return {
      model,
      ok: false,
      reason,
      latencyMs,
      transient: isTransientFailure(status, reason),
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

/** 带工具的一次调用返回 */
export interface ToolTurnResult {
  /** 模型这一步说的话。可能为空(它只想调工具) */
  readonly text: string;
  /** 模型请求的工具调用。为空表示它认为任务完成了 */
  readonly toolCalls: readonly {
    id: string;
    name: string;
    rawArguments: string;
  }[];
  readonly usage: ChatUsage;
  /** 上游给的结束原因,用于判断是否被长度截断 */
  readonly finishReason: string | null;
}

/**
 * 带工具的一次调用(非流式)。
 *
 * 为什么工具循环用非流式:流式下工具调用参数是分片拼接的,拼错一个字符
 * 整次调用就废了;而且循环里每一步都要等参数完整才能执行,流式并不能
 * 让用户更早看到东西。每步短、结果确定,比追求流畅更重要。
 *
 * 最终答案仍然可以流式呈现 —— 那是循环结束之后的事。
 *
 * 只支持 OpenAI 兼容协议。Anthropic 与 Google 的工具协议不同,
 * 需要各自的适配;在它们接入之前,调用方应先检查 supportsTools。
 */
export async function callWithTools({
  credentials,
  model,
  messages,
  tools,
  signal,
}: {
  credentials: ProviderCredentials;
  model: string;
  /** 允许带 tool 角色的消息 —— 工具结果要按协议回喂 */
  messages: readonly Record<string, unknown>[];
  tools: readonly unknown[];
  signal: AbortSignal;
}): Promise<ToolTurnResult> {
  const apiKey = decryptSecret(credentials.apiKeyCipher);
  const response = await fetch(`${resolveBaseUrl(credentials)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      stream: false,
    }),
    signal,
  });

  if (!response.ok) {
    throw new ProviderCallError(await describeFailure(response, model), response.status);
  }

  const payload = (await response.json()) as {
    choices?: {
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: {
          id?: string;
          function?: { name?: string; arguments?: string };
        }[];
      };
      finish_reason?: string | null;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = payload.choices?.[0];
  const message = choice?.message;

  const toolCalls = (message?.tool_calls ?? []).flatMap((c) =>
    c.function?.name
      ? [
          {
            id: c.id ?? `call_${c.function.name}`,
            name: c.function.name,
            rawArguments: c.function.arguments ?? "",
          },
        ]
      : [],
  );

  return {
    // 推理模型可能只给 reasoning_content。它不是答案,但完全丢掉会让
    // 「模型什么都没说」变得无法解释,所以在没有正文时退而用它。
    text: message?.content ?? message?.reasoning_content ?? "",
    toolCalls,
    usage: {
      inputTokens: payload.usage?.prompt_tokens ?? null,
      outputTokens: payload.usage?.completion_tokens ?? null,
    },
    finishReason: choice?.finish_reason ?? null,
  };
}
