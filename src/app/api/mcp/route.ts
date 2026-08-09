import { NextResponse, type NextRequest } from "next/server";

import { logger } from "@/lib/log";
import {
  handleRpc,
  rpcError,
  RPC_INVALID_REQUEST,
  RPC_PARSE_ERROR,
  type JsonRpcRequest,
} from "@/lib/mcp/protocol";
import { readBearerToken, verifyToken } from "@/lib/mcp/tokens";
import { checkRateLimit, type RateLimitRule } from "@/lib/services/rate-limit";

/**
 * MCP Server 端点。
 *
 * 这是智一 AI 对外的唯一接口 —— OpenClaw、Hermes Agent,以及任何支持 MCP
 * 的客户端都从这里接进来。用户买的是「工作流资产」,那资产就必须能被任何
 * 运行时消费,而不是锁在一个网页里。
 *
 * 无状态 Streamable HTTP:只实现 POST,不做 SSE、不维护会话。
 * 无服务器函数随时会被回收,维持不了长连接;每个 POST 自带 Authorization、
 * 自成一次完整往返,才是这个运行环境里唯一站得住的模型。
 *
 * ⚠️ 这是本系统第一个**不走浏览器会话**的入口。浏览器那条路上有
 * 会话 Cookie + RLS 双保险;这条路上令牌解析出的 organizationId 就是
 * 最终结论。所以:任何一处拿不准都必须拒绝,不允许有「放行试试」的分支。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 限流。
 *
 * 比对话路径宽:MCP 的调用方是长期运行的智能体,列文件、读文件这类
 * 轻量调用本来就密集。但必须有 —— 这是公网入口,而且每次调用都要打数据库。
 */
const MCP_LIMITS: readonly RateLimitRule[] = [
  { windowSeconds: 60, max: 120, label: "每分钟最多 120 次" },
  { windowSeconds: 3600, max: 2000, label: "每小时最多 2000 次" },
];

/** 未授权一律回这个,不区分「没带令牌」和「令牌不对」—— 那是在帮人试探 */
function unauthorized(): NextResponse {
  return NextResponse.json(
    rpcError(null, RPC_INVALID_REQUEST, "未授权:请在 Authorization 头里带上有效的 MCP 令牌"),
    {
      status: 401,
      // 按 RFC 6750,401 要带这个头,客户端据此知道该怎么认证
      headers: { "WWW-Authenticate": 'Bearer realm="zhiyi-ai-mcp"' },
    },
  );
}

export async function POST(request: NextRequest) {
  const identity = await verifyToken(
    readBearerToken(request.headers.get("authorization")),
  );
  if (!identity) return unauthorized();

  const limit = await checkRateLimit(`mcp:${identity.tokenId}`, MCP_LIMITS);
  if (!limit.allowed) {
    return NextResponse.json(
      rpcError(null, RPC_INVALID_REQUEST, limit.reason ?? "请求过于频繁"),
      { status: 429 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(rpcError(null, RPC_PARSE_ERROR, "请求体不是合法 JSON"), {
      status: 400,
    });
  }

  // 规范允许批量:一个数组里放多条消息
  const batch = Array.isArray(payload) ? payload : [payload];
  if (batch.length === 0) {
    return NextResponse.json(rpcError(null, RPC_INVALID_REQUEST, "空请求"), {
      status: 400,
    });
  }

  try {
    const responses = [];
    for (const message of batch) {
      const result = await handleRpc(
        message as JsonRpcRequest,
        identity.organizationId,
      );
      // null = 通知,按规范不回响应
      if (result !== null) responses.push(result);
    }

    // 全是通知时按规范回 202 且没有响应体
    if (responses.length === 0) return new NextResponse(null, { status: 202 });

    return NextResponse.json(Array.isArray(payload) ? responses : responses[0]);
  } catch (e) {
    logger.error(
      {
        organizationId: identity.organizationId,
        tokenId: identity.tokenId,
        err: e instanceof Error ? e.message : "unknown",
      },
      "MCP 请求处理异常",
    );
    return NextResponse.json(
      rpcError(null, RPC_INVALID_REQUEST, "服务端处理失败"),
      { status: 500 },
    );
  }
}

/**
 * GET 用于探活。
 *
 * 不在这里开 SSE:无服务器函数维持不了长连接,开了只会让客户端
 * 建立一个随时会断的流,然后把断线当成故障。明说不支持,比装作支持好。
 */
export async function GET(request: NextRequest) {
  const identity = await verifyToken(
    readBearerToken(request.headers.get("authorization")),
  );
  if (!identity) return unauthorized();

  return NextResponse.json({
    server: "zhiyi-ai",
    transport: "streamable-http (stateless, POST only)",
    organization: identity.organizationId,
    note: "本端点不提供 SSE —— 无服务器函数维持不了长连接。请用 POST 发送 JSON-RPC。",
  });
}
