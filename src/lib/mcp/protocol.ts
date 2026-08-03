import "server-only";

import { MCP_TOOLS, executeMcpTool } from "@/lib/mcp/tools";

/**
 * MCP 的 JSON-RPC 2.0 处理。
 *
 * 为什么手写而不引 @modelcontextprotocol/sdk:
 *
 *   1. 无状态 HTTP 模式下,协议面就是下面这五个方法。SDK 的价值主要在
 *      SSE / 会话管理 / 传输抽象,而那几样在无服务器函数里恰恰用不上 ——
 *      函数随时被回收,维持不了长连接。
 *   2. SDK 的传输层要 Node 的 req/res,而 Next.js App Router 给的是
 *      Web 标准的 Request/Response,中间要垫一层适配。
 *   3. 这条链路对外开放、握着整个组织的工作区读写。多一个依赖就多一处
 *      供应链风险,而本项目在 GitHub App 的 JWT 签名上已经做过同样的取舍。
 *
 * 无状态是刻意的:不实现 SSE,不维护会话。每个 POST 自带 Authorization,
 * 自成一次完整的请求-响应。在会被随时回收的函数里,这是唯一站得住的模型。
 */

/** 我们实现的协议版本。客户端报别的版本时按规范回我们支持的这个 */
export const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** JSON-RPC 2.0 规定的错误码 */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/**
 * 处理一条 JSON-RPC 消息。
 *
 * 返回 null 表示这是一条**通知**(没有 id),按规范不能回响应 ——
 * 回了会让严格的客户端报错。
 */
export async function handleRpc(
  message: JsonRpcRequest,
  organizationId: string,
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined || message.id === null;

  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return isNotification
      ? null
      : rpcError(id, RPC_INVALID_REQUEST, "不是合法的 JSON-RPC 2.0 请求");
  }

  switch (message.method) {
    // 握手。客户端报自己的版本,我们回自己支持的 —— 规范允许不一致,
    // 由客户端决定要不要继续
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          // 只声明真正实现了的。声明了 resources/prompts 却没实现,
          // 客户端会去调然后拿到 method not found —— 那是我们的错,不是它的
          tools: { listChanged: false },
        },
        serverInfo: { name: "zhiyi-ai", version: "1" },
        instructions:
          "智一 AI 的工作流资产接口。产出的文件写进工作区,不要只放在回答里 —— " +
          "工作区是跨会话保留的,回答不是。",
      });

    // 通知类:客户端告知握手完成。不回响应
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const params = message.params as
        | { name?: unknown; arguments?: unknown }
        | undefined;
      const name = params?.name;
      if (typeof name !== "string") {
        return rpcError(id, RPC_INVALID_PARAMS, "缺少工具名");
      }
      if (!MCP_TOOLS.some((t) => t.name === name)) {
        return rpcError(id, RPC_INVALID_PARAMS, `未知的工具:${name}`);
      }

      const outcome = await executeMcpTool(
        name,
        params?.arguments ?? {},
        organizationId,
      );

      // 工具**执行**失败要用 isError 表达,不是 JSON-RPC 层的 error。
      // 后者代表「这次调用本身不成立」(方法不存在、参数不合法),
      // 而工具跑了但没成功是一个**结果** —— 模型需要看到它并据此改正,
      // 当成传输错误抛出去,对面只会看到一句无从下手的内部错误。
      return rpcResult(id, {
        content: [{ type: "text", text: outcome.text }],
        isError: outcome.isError,
      });
    }

    default:
      return isNotification
        ? null
        : rpcError(id, RPC_METHOD_NOT_FOUND, `不支持的方法:${message.method}`);
  }
}
