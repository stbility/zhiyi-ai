import { describe, expect, it, vi } from "vitest";

/**
 * MCP client 层(src/lib/mcp/client.ts)。
 *
 * 这是智一智能体调用**外部** MCP server 的通道。守的是:
 *   1. 协议合规:initialize / tools/list / tools/call 的请求形状必须符合
 *      JSON-RPC 2.0,对面是标准 MCP server,不按规范写就接不上
 *   2. 错误语义:外部 server 不可达/超时/401/非 JSON 响应,一律收敛成
 *      「解释得清的观察结果」,永不抛错 —— 抛错会让整轮 agent 崩掉,
 *      而失败只是模型需要看到的观察
 *   3. 安全:url 必须 https(仅 localhost 允许 http);结果截断
 */

interface ServerConfig {
  id: string;
  name: string;
  url: string;
  authToken: string;
  timeoutMs: number;
}

function cfg(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "github",
    url: "https://mcp.example.com",
    authToken: "secret-token",
    timeoutMs: 5000,
    ...overrides,
  };
}

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return await import("@/lib/mcp/client");
}

describe("MCP client 协议", () => {
  it("initialize 发送 JSON-RPC 2.0 请求并解析 serverInfo", async () => {
    const { mcpInitialize } = await load();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: expect.anything(),
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "external-server", version: "1" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await mcpInitialize(cfg());
    expect(out.ok).toBe(true);

    // 请求形状:POST + Bearer + JSON-RPC 2.0
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://mcp.example.com");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-token",
    );
    const body = JSON.parse(init.body as string);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("initialize");
    vi.unstubAllGlobals();
  });

  it("tools/list 解析工具清单", async () => {
    const { mcpListTools } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              tools: [
                { name: "get_issues", description: "列 issues", inputSchema: { type: "object" } },
                { name: "create_issue", description: "建 issue", inputSchema: { type: "object" } },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const out = await mcpListTools(cfg());
    expect(out.ok).toBe(true);
    expect(out.tools ?? []).toHaveLength(2);
    expect(out.tools?.[0]?.name).toBe("get_issues");
    expect(out.tools?.[0]?.description).toBe("列 issues");
    vi.unstubAllGlobals();
  });

  it("tools/list 丢弃无名字的工具(防脏数据注入工具循环)", async () => {
    const { mcpListTools } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              tools: [{ description: "没有名字" }, { name: "", description: "空名字" }],
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const out = await mcpListTools(cfg());
    expect(out.ok).toBe(true);
    expect(out.tools ?? []).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("tools/call 提取文本内容(数组或字符串)", async () => {
    const { mcpCallTool } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: "hello" }],
              isError: false,
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const out = await mcpCallTool(cfg(), "get_issue", { id: 1 });
    expect(out.isError).toBe(false);
    expect(out.content).toBe("hello");
    vi.unstubAllGlobals();
  });

  it("tools/call 透传 isError(工具执行失败是结果,不是传输错误)", async () => {
    const { mcpCallTool } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: "权限不足" }], isError: true },
          }),
          { status: 200 },
        ),
      ),
    );
    const out = await mcpCallTool(cfg(), "delete_issue", {});
    expect(out.isError).toBe(true);
    expect(out.content).toBe("权限不足");
    vi.unstubAllGlobals();
  });
});

describe("MCP client 错误语义", () => {
  it("网络失败收敛成观察结果,不抛错", async () => {
    const { mcpListTools } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const out = await mcpListTools(cfg());
    expect(out.ok).toBe(false);
    expect(out.message).toContain("无法连接");
    vi.unstubAllGlobals();
  });

  it("HTTP 401 说清是凭据问题", async () => {
    const { mcpListTools } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const out = await mcpListTools(cfg());
    expect(out.ok).toBe(false);
    expect(out.message).toContain("401");
    expect(out.message).toContain("凭据");
    vi.unstubAllGlobals();
  });

  it("非 JSON 响应说清问题", async () => {
    const { mcpListTools } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>not json</html>", { status: 200 })),
    );
    const out = await mcpListTools(cfg());
    expect(out.ok).toBe(false);
    expect(out.message).toContain("JSON");
    vi.unstubAllGlobals();
  });

  it("JSON-RPC error 字段透传消息", async () => {
    const { mcpListTools } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32601, message: "Method not found" },
          }),
          { status: 200 },
        ),
      ),
    );
    const out = await mcpListTools(cfg());
    expect(out.ok).toBe(false);
    expect(out.message).toContain("Method not found");
    vi.unstubAllGlobals();
  });
});

describe("MCP client 安全", () => {
  it("结果超过上限被截断并如实标注", async () => {
    const { mcpCallTool } = await load();
    const big = "x".repeat(40_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: big }] },
          }),
          { status: 200 },
        ),
      ),
    );
    const out = await mcpCallTool(cfg(), "big_tool", {});
    expect(out.content.length).toBeLessThan(31_000);
    expect(out.content).toContain("截断");
    expect(out.content).toContain("40000");
    vi.unstubAllGlobals();
  });

  it("url 校验:https 放行,http 只放行 localhost,其余拒绝", async () => {
    const { validateServerUrl } = await load();
    expect(validateServerUrl("https://mcp.example.com")).toBeNull();
    expect(validateServerUrl("http://localhost:8080")).toBeNull();
    expect(validateServerUrl("http://127.0.0.1:3000")).toBeNull();
    expect(validateServerUrl("http://mcp.example.com")).toContain("https");
    expect(validateServerUrl("not a url")).toBe("不是合法的 URL");
  });

  it("工具名前缀:parseMcpToolName 双向还原", async () => {
    const { mcpToolName, parseMcpToolName } = await load();
    const full = mcpToolName("github", "get_issues");
    expect(full).toBe("mcp__github__get_issues");
    const parsed = parseMcpToolName(full);
    expect(parsed?.serverName).toBe("github");
    expect(parsed?.toolName).toBe("get_issues");
    expect(parseMcpToolName("write_file")).toBeNull();
    expect(parseMcpToolName("mcp__noprefix")).toBeNull();
  });
});
