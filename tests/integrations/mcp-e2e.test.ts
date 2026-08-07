import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * MCP client 端到端验证 —— 本地起一个**真实的 HTTP MCP server**,
 * 用 src/lib/mcp/client.ts 完整走一遍协议:
 * initialize 握手 → tools/list 拿清单 → tools/call 执行。
 *
 * 与 tests/mcp/client.test.ts 的区别:那边是 mock fetch 的单元测试,
 * 验证「client 逻辑正确」;这里是真实 HTTP 往返,验证「协议实现真的
 * 能跟一个外部 server 说话」。server 在 127.0.0.1 本地回环 ——
 * 确定性、无外网依赖,所以进主门禁(pnpm test)。
 *
 * 这是产品链路「接一个 MCP server → 工具出现在列表 → 调用成功」的
 * 协议层证明;数据库登记层(buildExternalContext)与 agent 装配层
 * 由 tests/mcp/external.test.ts 覆盖。
 */

vi.mock("server-only", () => ({}));

import {
  mcpCallTool,
  mcpInitialize,
  mcpListTools,
  type McpServerConfig,
} from "@/lib/mcp/client";

const TOKEN = "e2e-test-token";

/** 极简 MCP server:JSON-RPC 2.0 over HTTP,只实现我们要的三件事 */
function createMcpServer(): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      // 鉴权:Bearer 必须对。401 是凭据问题的代表场景
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        send(401, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "unauthorized" },
        });
        return;
      }

      let body: { id?: unknown; method?: unknown; params?: unknown } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        return;
      }

      const { id, method, params } = body;

      if (method === "initialize") {
        send(200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "e2e-test-server", version: "1.0.0" },
          },
        });
        return;
      }

      if (method === "tools/list") {
        send(200, {
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "echo",
                description: "回显输入文本",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
              {
                name: "add",
                description: "两数相加",
                inputSchema: {
                  type: "object",
                  properties: { a: { type: "number" }, b: { type: "number" } },
                  required: ["a", "b"],
                },
              },
              {
                name: "slow",
                description: "故意慢,测超时",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
        return;
      }

      if (method === "tools/call") {
        const p = params as { name?: unknown; arguments?: unknown };
        const name = typeof p.name === "string" ? p.name : "";
        const args = (p.arguments ?? {}) as Record<string, unknown>;

        // 慢工具:200ms 后回 —— 客户端用 timeoutMs 50 来打它
        if (name === "slow") {
          setTimeout(() => {
            send(200, {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: "终于好了" }] },
            });
          }, 200);
          return;
        }

        if (name === "echo") {
          send(200, {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: String(args.text ?? "") }] },
          });
          return;
        }

        if (name === "add") {
          const sum = (Number(args.a) || 0) + (Number(args.b) || 0);
          send(200, {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: String(sum) }] },
          });
          return;
        }

        // 未知工具:JSON-RPC 错误 —— client 应如实回喂给模型
        send(200, {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "未知工具: " + name },
        });
        return;
      }

      send(200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "method not found: " + String(method) },
      });
    });
  });
}

let server: Server;
let baseUrl: string;
let cfg: McpServerConfig;

beforeAll(async () => {
  server = createMcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server 没起来");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cfg = {
    id: "e2e-server",
    name: "e2e",
    url: baseUrl,
    authToken: TOKEN,
    timeoutMs: 5_000,
  };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("MCP client ↔ 真实 HTTP server 端到端", () => {
  it("initialize 握手成功,拿到 serverInfo", async () => {
    const out = await mcpInitialize(cfg);
    expect(out.ok).toBe(true);
    expect(out.message).toBe("连接成功");
    expect(out.serverInfo).toMatchObject({ name: "e2e-test-server", version: "1.0.0" });
  });

  it("tools/list 拿到工具清单,inputSchema 被解析", async () => {
    const out = await mcpListTools(cfg);
    expect(out.ok).toBe(true);
    expect(out.message).toBe("发现 3 个工具");
    expect(out.tools.map((t) => t.name)).toEqual(["echo", "add", "slow"]);
    const echo = out.tools.find((t) => t.name === "echo");
    expect(echo?.inputSchema).toMatchObject({ type: "object" });
  });

  it("tools/call echo 回显文本", async () => {
    const out = await mcpCallTool(cfg, "echo", { text: "你好,MCP" });
    expect(out.isError).toBe(false);
    expect(out.content).toBe("你好,MCP");
  });

  it("tools/call add 执行计算", async () => {
    const out = await mcpCallTool(cfg, "add", { a: 1, b: 2 });
    expect(out.isError).toBe(false);
    expect(out.content).toBe("3");
  });

  it("tools/call 未知工具:JSON-RPC 错误如实回喂,不抛异常", async () => {
    const out = await mcpCallTool(cfg, "no_such_tool", {});
    expect(out.isError).toBe(true);
    expect(out.content).toContain("未知工具");
  });

  it("凭据错误:server 401 → 提示凭据无效", async () => {
    const bad = { ...cfg, authToken: "wrong-token" };
    const out = await mcpInitialize(bad);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("凭据无效");
  });

  it("大结果截断:40000 字符 → 截到 30000 并如实标注", async () => {
    const big = "x".repeat(40_000);
    const out = await mcpCallTool(cfg, "echo", { text: big });
    expect(out.isError).toBe(false);
    expect(out.content.length).toBeLessThanOrEqual(30_500);
    expect(out.content).toContain("此处截断");
  });

  it("超时:slow 工具 + 50ms 预算 → 报连接超时", async () => {
    const fast = { ...cfg, timeoutMs: 50 };
    const out = await mcpCallTool(fast, "slow", {});
    expect(out.isError).toBe(true);
    expect(out.content).toContain("连接超时");
  });
});
