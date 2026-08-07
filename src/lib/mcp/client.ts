import "server-only";

/**
 * MCP client 层 —— 智一智能体调用**外部** MCP server 的通道。
 *
 * 与 server 端(src/lib/mcp/protocol.ts)对称:
 *   server 端:别人(OpenClaw、Hermes…)通过 JSON-RPC 调我们的工具
 *   client 端:我们的 agent 通过 JSON-RPC 调别人的工具 (mcp__<server>__<tool>)
 *
 * 为什么也手写而不引 @modelcontextprotocol/sdk:
 *   与 server 端同一个理由 —— SDK 的价值在 SSE/会话管理/传输抽象,
 *   而无服务器函数用不上;多一个依赖多一处供应链风险。
 *   我们要的只是三件事:initialize 握手、tools/list 拿清单、tools/call 执行。
 *
 * 安全模型(沿 server 端的纪律):
 *   1. url 必须 https;http 只允许 localhost(测试用)。
 *   2. Bearer 令牌只存在于调用瞬间,不落日志。
 *   3. 外部 server 的返回是不可信输入 —— 一律当文本截断,回喂模型。
 *   4. 失败是观察结果,不是异常:server 不可达/超时/401 都返回 isError,
 *      模型看得懂也改得了,而不是让整轮 agent 运行崩掉。
 */

/** 单次工具调用回喂给模型的内容上限 —— 与内置工具同一个数 */
const MAX_RESULT_CHARS = 30_000;

/** 登记在 mcp_servers 表里的一个外部 server(运行时装配) */
export interface McpServerConfig {
  readonly id: string;
  /** 工具前缀用,如 github → mcp__github__* */
  readonly name: string;
  readonly url: string;
  /** 明文 Bearer 令牌。只在调用瞬间存在 */
  readonly authToken: string;
  readonly timeoutMs: number;
}

/** 外部 server 暴露的一个工具 */
export interface McpRemoteTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** 工具调用结果。与内置 ToolResult 同构 —— 成功失败都是观察 */
export interface McpRemoteResult {
  readonly content: string;
  readonly isError: boolean;
}

/** 工具名前缀:mcp__<server>__<tool>。防撞名,也一眼看出来源 */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * 清洗远程 MCP 工具名,使其符合 OpenAI 兼容接口对 function name 的约束
 * (^[a-zA-Z0-9_-]{1,64}$)。远程 MCP 工具名不受该约束 —— 可能含点号、
 * 空格或超过 64 字符;超限/非法字符会让严格 enforce 的服务商整个 tools
 * 参数 400 拒绝,整轮 agent 失败。
 *
 * 策略:非法字符 → _、截断 64。注意 mcp__<server>__<tool> 前缀本身
 * 占字符,截断以最终工具名总长为准(在 agent.ts 装配处再兜底)。
 */
export function sanitizeRemoteToolName(raw: string): string {
  // 只替换非法字符(OpenAI function name 约束 ^[a-zA-Z0-9_-]{1,64}$),
  // 合法下划线/连字符原样保留 —— 连续下划线在约束内,不去合并
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  // 全非法字符(清洗后只剩 _)或空串 → 兜底,避免工具名就是 "_"
  const trimmed = cleaned.replace(/^_+|_+$/g, "");
  return (trimmed || "tool").slice(0, 64);
}

/** 从 mcp__<server>__<tool> 还原 server 名;不是 mcp__ 开头返回 null */
export function parseMcpToolName(name: string): {
  readonly serverName: string;
  readonly toolName: string;
} | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  return {
    serverName: rest.slice(0, sep),
    toolName: rest.slice(sep + 2),
  };
}

/** url 校验:https 强制;http 只放行 localhost(本地测试) */
export function validateServerUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "不是合法的 URL";
  }
  if (parsed.protocol === "https:") return null;
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  ) {
    return null;
  }
  return "URL 必须是 https(仅 localhost 允许 http)";
}

/** JSON-RPC 2.0 请求体。与 server 端同一形状 */
interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 通知(无 id、不回响应)。规范要求 initialize 成功后发 */
interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * 发一条 JSON-RPC 请求,拿响应或一个解释得清的错误。
 *
 * 永不抛错 —— 返回值永远带着 isError 语义,调用方不需要 try/catch。
 * 网络失败、超时、非 JSON 响应、协议错误,全部在这里收敛成文字。
 */
async function rpc(
  cfg: McpServerConfig,
  method: string,
  params: unknown,
): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> {
  // P2-8:SSRF 守卫 —— 请求发出前校验 server 地址。validateServerUrl
  // 只拦协议(http 非 localhost),拦不住 https 指向私网 IP / 内网域名 /
  // DNS rebinding。base-url-guard 做运行时 DNS 解析 + 私网段判定,
  // 与 gateway.ts 对 provider base_url 的守卫同一条纪律。
  // localhost/127.0.0.1 例外:MCP 产品语义明确允许(本地测试 server,
  // validateServerUrl 已放行),守卫只管外部地址。
  const host = new URL(cfg.url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    const { assertSafeBaseUrl } = await import("@/lib/ai/base-url-guard");
    const guardProblem = await assertSafeBaseUrl(cfg.url);
    if (guardProblem) {
      return { ok: false, message: `server 地址校验失败:${guardProblem}` };
    }
  }

  const body: RpcRequest = { jsonrpc: "2.0", id: Date.now(), method, params };

  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.authToken}`,
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      // 外部 server 可能很慢,但 agent 的预算有限。超时宁可失败,不烧预算
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    // 传输层失败:连不上、TLS 握手失败、超时中止
    return {
      ok: false,
      message:
        e instanceof Error && e.name === "TimeoutError"
          ? `连接超时(${cfg.timeoutMs}ms)。server 可能过载,请稍后重试或调大超时。`
          : `无法连接 server:${e instanceof Error ? e.message : "未知错误"}`,
    };
  }

  if (!res.ok) {
    // 401/403 是凭据问题,4xx 是配置问题,5xx 是 server 自身问题 ——
    // 都如实说,模型能据此判断「是去改配置还是等它恢复」
    return {
      ok: false,
      message: `server 返回 HTTP ${res.status}${
        res.status === 401 || res.status === 403 ? "(凭据无效,请检查令牌)" : ""
      }`,
    };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, message: "server 返回的不是合法 JSON" };
  }

  // 规范允许批量(数组),但我们只发单条 —— 只处理单条响应
  const msg = (Array.isArray(payload) ? payload[0] : payload) as
    | RpcResponse
    | undefined;

  if (!msg || msg.jsonrpc !== "2.0") {
    return { ok: false, message: "server 返回的不是合法的 JSON-RPC 2.0 响应" };
  }
  if (msg.error) {
    return {
      ok: false,
      message: `server 返回错误:${msg.error.message ?? "未知错误"}(code ${msg.error.code ?? "?"})`,
    };
  }
  return { ok: true, result: msg.result };
}

/**
 * 发一条 JSON-RPC 通知(无 id、不等待响应)。规范要求 initialize
 * 成功后补发 notifications/initialized;严格 server(SDK 生成)可能
 * 在收到它之前拒绝后续 tools/list。fire-and-forget:失败不阻塞
 * —— 通知是尽力而为,工具调用仍会尝试。
 */
async function sendNotification(
  cfg: McpServerConfig,
  method: string,
  params: unknown,
): Promise<void> {
  const body: RpcNotification = { jsonrpc: "2.0", method, params };
  try {
    await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.authToken}`,
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, 5000)),
    });
  } catch {
    // 通知失败不报错 —— 严格 server 才会拒后续请求,
    // 那种情况 tools/list 会如实返回错误,由调用方处理
  }
}

/** initialize 握手。连接验证(界面「测试连接」)与运行时都用它 */
export async function mcpInitialize(cfg: McpServerConfig): Promise<{
  ok: boolean;
  message: string;
  serverInfo?: unknown;
}> {
  const out = await rpc(cfg, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "zhiyi-ai", version: "1" },
  });
  if (!out.ok) return { ok: false, message: out.message };
  const result = out.result as {
    protocolVersion?: unknown;
    capabilities?: { tools?: unknown };
    serverInfo?: unknown;
  } | undefined;

  // P2-7:校验协议版本与 capabilities.tools —— server 声称不支持
  // 工具或协议不匹配时如实报告,而不是继续走后面必然失败的步骤。
  if (result?.protocolVersion && result.protocolVersion !== "2025-06-18") {
    return {
      ok: false,
      message: `server 协议版本(${String(result.protocolVersion)})与本客户端(2025-06-18)不兼容`,
    };
  }
  if (result?.capabilities && result.capabilities.tools === false) {
    return { ok: false, message: "server 声明不支持 tools 能力" };
  }

  // P2-6:握手成功后补发 notifications/initialized(MCP 规范)。
  // 等待响应会拖慢测试连接;fire-and-forget,失败不阻塞。
  await sendNotification(cfg, "notifications/initialized", {});

  return {
    ok: true,
    message: "连接成功",
    serverInfo: result?.serverInfo,
  };
}

/** tools/list:拉取外部 server 暴露的工具清单 */
export async function mcpListTools(
  cfg: McpServerConfig,
): Promise<{ ok: boolean; message: string; tools: McpRemoteTool[] }> {
  const out = await rpc(cfg, "tools/list", {});
  if (!out.ok) return { ok: false, message: out.message, tools: [] };

  const result = out.result as { tools?: unknown } | undefined;
  const rawTools = Array.isArray(result?.tools) ? result.tools : [];
  const tools: McpRemoteTool[] = [];
  for (const raw of rawTools) {
    const t = raw as {
      name?: unknown;
      description?: unknown;
      inputSchema?: unknown;
    };
    if (typeof t.name !== "string" || t.name === "") continue;
    tools.push({
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      inputSchema:
        typeof t.inputSchema === "object" && t.inputSchema !== null
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    });
  }
  return { ok: true, message: `发现 ${tools.length} 个工具`, tools };
}

/** tools/call:执行外部工具。结果一律截断,防巨型返回烧上下文 */
export async function mcpCallTool(
  cfg: McpServerConfig,
  toolName: string,
  args: unknown,
): Promise<McpRemoteResult> {
  const out = await rpc(cfg, "tools/call", { name: toolName, arguments: args });
  if (!out.ok) {
    return { content: out.message, isError: true };
  }

  const result = out.result as {
    content?: unknown;
    isError?: unknown;
  } | undefined;

  // 规范:content 是 [{type:"text",text:"..."}] 数组;非文本内容给说明
  let text = "";
  if (Array.isArray(result?.content)) {
    text = result.content
      .map((block) => {
        const b = block as { type?: unknown; text?: unknown };
        if (b.type === "text" && typeof b.text === "string") return b.text;
        return `[${b.type ?? "未知"} 类型内容]`;
      })
      .join("\n");
  } else if (typeof result?.content === "string") {
    text = result.content;
  } else {
    text = "server 没有返回可读内容";
  }

  if (text.length > MAX_RESULT_CHARS) {
    text = capMcpResult(text);
  }
  return { content: text, isError: result?.isError === true };
}

/** 截断并如实标注。与内置 capToolResult 同一条规则:让模型看见截断 */
function capMcpResult(content: string): string {
  return (
    content.slice(0, MAX_RESULT_CHARS) +
    `\n\n…[外部工具结果过长,此处截断。原文共 ${content.length} 个字符,` +
    `已显示前 ${MAX_RESULT_CHARS} 个。需要后面的部分请缩小查询范围再调。]`
  );
}
