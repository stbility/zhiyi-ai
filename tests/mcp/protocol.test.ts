import { describe, expect, it, vi } from "vitest";

/**
 * MCP 协议层。
 *
 * 这里守的是**协议合规**,不是功能:接进来的是 OpenClaw、Hermes 这类
 * 我们控制不了的客户端,它们按规范办事。任何一处偏差(通知回了响应、
 * 工具失败当成传输错误抛出去、能力声明了没实现)都会表现为
 * 「对面连不上/一调就报错」,而我们这边看不出哪里不对。
 */

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  vi.doMock("@/lib/mcp/tools", async () => {
    const actual =
      await vi.importActual<typeof import("@/lib/mcp/tools")>("@/lib/mcp/tools");
    return {
      ...actual,
      executeMcpTool: vi.fn(async (name: string) => ({
        text: `执行了 ${name}`,
        isError: false,
      })),
    };
  });
  return await import("@/lib/mcp/protocol");
}

const ORG = "11111111-1111-1111-1111-111111111111";

describe("握手", () => {
  it("initialize 回协议版本、能力与服务端信息", async () => {
    const { handleRpc, PROTOCOL_VERSION } = await load();
    const r = await handleRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      ORG,
    );
    const result = r?.result as {
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo: { name: string };
    };
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.serverInfo.name).toBe("zhiyi-ai");
    // 只能声明真正实现了的能力:声明 resources/prompts 却没实现,
    // 客户端会去调然后拿到 method not found —— 那是我们的错
    expect(result.capabilities).toHaveProperty("tools");
    expect(result.capabilities).not.toHaveProperty("resources");
    expect(result.capabilities).not.toHaveProperty("prompts");
  });

  it("通知(没有 id)不回响应 —— 回了会让严格的客户端报错", async () => {
    const { handleRpc } = await load();
    expect(
      await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, ORG),
    ).toBeNull();
    expect(
      await handleRpc({ jsonrpc: "2.0", method: "notifications/cancelled" }, ORG),
    ).toBeNull();
  });

  it("不认识的通知也不回响应", async () => {
    const { handleRpc } = await load();
    expect(await handleRpc({ jsonrpc: "2.0", method: "从未见过的通知" }, ORG)).toBeNull();
  });
});

describe("工具列表", () => {
  it("字段名是 inputSchema,不是 OpenAI 的 parameters", async () => {
    const { handleRpc } = await load();
    const r = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ORG);
    const tools = (r?.result as { tools: Record<string, unknown>[] }).tools;
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t).toHaveProperty("inputSchema");
      expect(t).not.toHaveProperty("parameters");
      expect(typeof t["description"]).toBe("string");
    }
  });

  it("只暴露真实存在的能力 —— 还没建表的资产一个都不出现", async () => {
    const { handleRpc } = await load();
    const r = await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, ORG);
    const names = (r?.result as { tools: { name: string }[] }).tools.map(
      (t) => t.name,
    );
    // 品牌人格、技能库、长期记忆、评测集是 P5 才建的表。
    // 提前暴露一个返回空数据的工具,接入方会以为功能已通 ——
    // 这和界面上「未接通不得标记为已就绪」是同一条规则
    for (const notYet of [
      "zhiyi_get_persona",
      "zhiyi_list_skills",
      "zhiyi_search_memory",
      "zhiyi_run_eval",
    ]) {
      expect(names).not.toContain(notYet);
    }
  });
});

describe("工具调用", () => {
  it("工具执行失败用 isError 表达,不是 JSON-RPC 的 error", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/lib/mcp/tools", async () => {
      const actual =
        await vi.importActual<typeof import("@/lib/mcp/tools")>(
          "@/lib/mcp/tools",
        );
      return {
        ...actual,
        executeMcpTool: async () => ({ text: "文件不存在", isError: true }),
      };
    });
    const { handleRpc } = await import("@/lib/mcp/protocol");

    const r = await handleRpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "zhiyi_workspace_read", arguments: {} },
      },
      ORG,
    );

    // 关键:error 字段必须为空。工具跑了但没成功是一个**结果**,
    // 模型要看到它并据此改正;当成传输错误抛出去,对面只会看到
    // 一句无从下手的内部错误
    expect(r?.error).toBeUndefined();
    const result = r?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("文件不存在");
  });

  it("未知工具名走 JSON-RPC error —— 那才是「这次调用本身不成立」", async () => {
    const { handleRpc } = await load();
    const r = await handleRpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "不存在的工具", arguments: {} },
      },
      ORG,
    );
    expect(r?.error?.code).toBe(-32602);
  });

  it("缺少工具名时报参数错误,不是内部错误", async () => {
    const { handleRpc } = await load();
    const r = await handleRpc(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: {} },
      ORG,
    );
    expect(r?.error?.code).toBe(-32602);
  });
});

describe("协议基本面", () => {
  it("不支持的方法回 -32601", async () => {
    const { handleRpc } = await load();
    const r = await handleRpc(
      { jsonrpc: "2.0", id: 7, method: "resources/list" },
      ORG,
    );
    expect(r?.error?.code).toBe(-32601);
  });

  it("jsonrpc 版本不对时拒绝", async () => {
    const { handleRpc } = await load();
    const r = await handleRpc(
      { jsonrpc: "1.0", id: 8, method: "ping" } as never,
      ORG,
    );
    expect(r?.error?.code).toBe(-32600);
  });

  it("ping 回空对象 —— 客户端用它探活", async () => {
    const { handleRpc } = await load();
    const r = await handleRpc({ jsonrpc: "2.0", id: 9, method: "ping" }, ORG);
    expect(r?.result).toEqual({});
    expect(r?.error).toBeUndefined();
  });
});
