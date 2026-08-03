import { describe, expect, it, vi } from "vitest";

import { sseResponse } from "../helpers/sse";

/**
 * 智能体的三处「看起来在工作、其实做不成事」。
 *
 * 这三个都不会报错、不会崩,所以既不会被类型检查发现,也不会被
 * 「能不能跑通」这类测试发现 —— 它们只会让用户拿到一个错的结果,
 * 或者白等一场。逐条钉死。
 */

const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  process.env["ENCRYPTION_KEY"] = ENCRYPTION_KEY;
  const { encryptSecret } = await import("@/lib/crypto/secret-box");
  const gateway = await import("@/lib/ai/gateway");
  const agent = await import("@/lib/ai/agent");
  return { gateway, agent, cipher: encryptSecret("k") };
}

const creds = (cipher: string) => ({
  kind: "openai_compatible" as const,
  baseUrl: "https://api.example.com/v1",
  apiKeyCipher: cipher,
});

const memoryTools = () => ({
  async readFile() {
    return null;
  },
  async writeFile() {},
  async listFiles() {
    return [];
  },
});

function streamOnce(turn: Parameters<typeof sseResponse>[0]) {
  return vi.fn().mockImplementation(async () => sseResponse(turn));
}

/** 把「一个服务商 + 一个模型」包成候选,凭据跟着候选走 */
function candidate(cipher: string, modelId: string, providerName = "测试服务商", providerId = "p1") {
  return {
    providerId,
    providerName,
    modelId,
    credentials: {
      kind: "openai_compatible" as const,
      baseUrl: "https://api.example.com/v1",
      apiKeyCipher: cipher,
    },
  };
}

describe("推理模型只给 reasoning_content 时", () => {
  it("思考过程走 reasoning 字段,不顶替正文", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal(
      "fetch",
      streamOnce({ reasoning: "我先看看目录结构。" }),
    );

    const turn = await gateway.callWithTools({
      credentials: creds(cipher),
      model: "reasoner",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });

    // 两个字段必须始终分开。
    //
    // 这里曾经是 `text: text !== "" ? text : reasoning` —— 思考过程直接
    // 顶替正文。后果是智能体把「它在想」判成「它答完了」:模型吐一句
    // 「我先看看目录结构」就被当作最终回答,循环第一步就收工,
    // 工作区 0 文件。用户看到的正是那个形态。
    //
    // 思考过程没有丢:它照样实时推给界面,而且模型停下时如果正文为空,
    // 智能体会拿它当回答显示(见 agent.ts)—— 那是**模型自己的话**,
    // 只是不能在循环中途冒充正文。
    expect(turn.text).toBe("");
    expect(turn.reasoning).toBe("我先看看目录结构。");
    vi.unstubAllGlobals();
  });

  it("有正文时不受影响,仍然取正文", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal(
      "fetch",
      streamOnce({ content: "答案在这里", reasoning: "思考…" }),
    );

    const turn = await gateway.callWithTools({
      credentials: creds(cipher),
      model: "reasoner",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });

    expect(turn.text).toBe("答案在这里");
    vi.unstubAllGlobals();
  });
});

describe("输出被长度上限截断时", () => {
  it("立刻停下并说清原因,不让模型拿着残缺 JSON 反复重试", async () => {
    const { agent, cipher } = await load();
    // finish_reason: length + 一个被截断的工具调用参数
    vi.stubGlobal(
      "fetch",
      // finish_reason: length —— 输出被长度上限截断,工具参数是残缺的
      streamOnce({
        toolCalls: [{ name: "write_file", args: { path: "a.ts", content: "export cons" } }],
        finishReason: "length",
      }),
    );

    const r = await agent.runAgent({
      model: candidate(cipher, "m"),
      userMessage: "写个大文件",
      history: [],
      toolContext: memoryTools(),
      signal: new AbortController().signal,
      limits: {
        maxSteps: 12,
        budgetMs: 60_000,
        maxConsecutiveFailures: 3,
        maxRetries: 0,
      },
    });

    expect(r.haltReason).toMatch(/长度上限截断/);
    // 只说发生了什么,不给建议 —— 界面不是我们替用户拿主意的地方。
    // 而且这句话走 SSE 的 error 通道,不会被拼进模型的回答里。
    expect(r.haltReason).toMatch(/截断/);
    expect(r.haltReason).not.toMatch(/建议|请|试试/);
    // 只烧掉一步,没有把剩下 11 步在同一个坑里耗光
    expect(r.steps.length).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe("工具结果回喂给模型时", () => {
  it("超长内容按上限截断,并明确告诉模型这里截断了", async () => {
    const { agent } = await load();
    const long = "x".repeat(agent.MAX_TOOL_RESULT_CHARS + 5_000);
    const capped = agent.capToolResult(long);

    expect(capped.length).toBeLessThan(long.length);
    // 不能悄悄截断:模型以为读到的是全文,据此改出来的代码是错的
    expect(capped).toMatch(/截断/);
    expect(capped).toMatch(new RegExp(String(long.length)));
    vi.unstubAllGlobals();
  });

  it("正常长度的结果原样保留,不做多余改动", async () => {
    const { agent } = await load();
    expect(agent.capToolResult("短内容")).toBe("短内容");
  });
});

describe("路径参数不该白烧一步", () => {
  /**
   * 真实故障:模型 list_files 看到空工作区,接着用 `/index.html` 去
   * read_file,撞上「路径必须是相对路径」,然后把 285 秒预算耗光,
   * 工作区一个文件都没有。
   *
   * 我们的路径是数据库里的键,不是磁盘路径 —— `/index.html` 和
   * `index.html` 本来就该是同一个文件。拒绝前者没有任何安全收益,
   * 代价却是实打实的一次运行。真正要防的是路径穿越,那条一步没松。
   */
  it("开头的斜杠规范化掉,不当错误", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { writeFileSchema } = await import("@/lib/ai/tools");

    const r = writeFileSchema.safeParse({ path: "/index.html", content: "x" });
    expect(r.success, "开头的斜杠仍然被当成错误").toBe(true);
    if (r.success) expect(r.data.path).toBe("index.html");
  });

  it("路径穿越仍然挡住 —— 规范化不能顺手把安全一起放了", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { writeFileSchema } = await import("@/lib/ai/tools");

    // 这一条是上一条的正向对照:证明放行斜杠不是把校验整个关掉了
    for (const bad of ["../etc/passwd", "a/../../b", "/../x", "///"]) {
      expect(
        writeFileSchema.safeParse({ path: bad, content: "x" }).success,
        `${bad} 被放行了`,
      ).toBe(false);
    }
  });

  it("参数报错要把出错的值回给模型,否则它只会原样再试一次", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { executeTool } = await import("@/lib/ai/tools");

    const r = await executeTool(
      {
        id: "c1",
        name: "write_file",
        rawArguments: JSON.stringify({ path: "../x", content: "y" }),
      },
      {
        async readFile() {
          return null;
        },
        async writeFile() {},
        async listFiles() {
          return [];
        },
      },
    );

    expect(r.ok).toBe(false);
    // 哪个参数、当时收到的是什么 —— 缺了这两样,模型无从修正
    expect(r.content).toContain("path");
    expect(r.content).toContain("../x");
  });
});
