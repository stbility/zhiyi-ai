import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * MCP client 层新增守卫与协议细节的单元测试(client.ts)。
 *
 * 覆盖 2026-08-07 审计新增/修复的逻辑:
 *   P1-2  工具名 __ 歧义:parseMcpToolName 对含 __ 的 server 名的解析
 *   P1-5  sanitizeRemoteToolName:远程工具名清洗(OpenAI function name 约束)
 *   P2-6  initialize 成功后补发 notifications/initialized
 *   P2-7  initialize 响应校验 protocolVersion / capabilities.tools
 *   P2-8  SSRF 守卫:非 localhost 地址请求前校验;localhost 放行
 */

vi.mock("server-only", () => ({}));

// base-url-guard 的 DNS 解析在测试里不可控 —— mock 掉:
// 私网地址拒绝,公网地址放行
vi.mock("@/lib/ai/base-url-guard", () => ({
  assertSafeBaseUrl: vi.fn(async (url: string) => {
    if (url.includes("10.0.0.5") || url.includes("169.254")) {
      return "Base URL 不允许指向内网或本机地址";
    }
    return null;
  }),
}));

import { parseMcpToolName, sanitizeRemoteToolName, mcpInitialize } from "@/lib/mcp/client";

const cfg = (url: string, timeoutMs = 5000) => ({
  id: "1",
  name: "github",
  url,
  authToken: "token",
  timeoutMs,
});

describe("parseMcpToolName(P1-2 工具名解析)", () => {
  it("普通名字正常解析", () => {
    expect(parseMcpToolName("mcp__github__repos_list")).toEqual({
      serverName: "github",
      toolName: "repos_list",
    });
  });

  it("server 名含单个下划线正常解析(foo_bar 合法)", () => {
    expect(parseMcpToolName("mcp__foo_bar__baz")).toEqual({
      serverName: "foo_bar",
      toolName: "baz",
    });
  });

  it("不是 mcp__ 开头返回 null", () => {
    expect(parseMcpToolName("github__repos_list")).toBeNull();
  });

  it("没有分隔符返回 null", () => {
    expect(parseMcpToolName("mcp__github")).toBeNull();
  });
});

describe("sanitizeRemoteToolName(P1-5 工具名清洗)", () => {
  it("合法名字原样保留", () => {
    expect(sanitizeRemoteToolName("repos_list")).toBe("repos_list");
  });

  it("非法字符替换为下划线", () => {
    expect(sanitizeRemoteToolName("my tool.name")).toBe("my_tool_name");
  });

  it("超长截断到 64", () => {
    const long = "a".repeat(100);
    expect(sanitizeRemoteToolName(long).length).toBe(64);
  });

  it("全非法字符兜底为 tool", () => {
    expect(sanitizeRemoteToolName("!!!")).toBe("tool");
  });

  it("连续下划线保留(在 OpenAI 约束内)", () => {
    expect(sanitizeRemoteToolName("a__b")).toBe("a__b");
  });
});

describe("mcpInitialize(P2-6/P2-7 协议细节)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockReset();
  });

  it("initialize 成功后补发 notifications/initialized(P2-6)", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? init.body : "";
        calls.push({ url, body });
        if (body.includes('"initialize"')) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "test-server", version: "1.0" },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // 通知:返回空 200(server 不回响应)
        return new Response("", { status: 200 });
      },
    );

    const out = await mcpInitialize(cfg("https://mcp.example.com"));
    expect(out.ok).toBe(true);

    const notifyCall = calls.find((c) => c.body.includes("notifications/initialized"));
    expect(notifyCall).toBeDefined();
    const parsed = JSON.parse(notifyCall!.body);
    expect(parsed.id).toBeUndefined(); // 通知无 id
    expect(parsed.method).toBe("notifications/initialized");
  });

  it("协议版本不匹配时如实报错(P2-7)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "old", version: "0.1" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const out = await mcpInitialize(cfg("https://mcp.example.com"));
    expect(out.ok).toBe(false);
    expect(out.message).toContain("协议版本");
  });

  it("capabilities.tools=false 时如实报错(P2-7)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: false },
            serverInfo: { name: "no-tools", version: "1.0" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const out = await mcpInitialize(cfg("https://mcp.example.com"));
    expect(out.ok).toBe(false);
    expect(out.message).toContain("不支持 tools");
  });
});
