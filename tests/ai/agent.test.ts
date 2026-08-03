import { describe, expect, it, vi } from "vitest";

/**
 * 智能体循环测试。
 *
 * 这里守的主要是**护栏**,不是功能。理由很直接:
 * 一个没有上限的循环就是一台烧钱机器 —— 模型完全可能在两个工具之间
 * 反复横跳,每一跳都是一次真实的 API 调用,账单落在用户头上。
 *
 * 所以「到达上限会停」比「能跑通」更需要被测死;而且停下时必须**如实说明**,
 * 不能假装任务完成了 —— 那会让用户以为文件都写好了。
 */

const ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  process.env["ENCRYPTION_KEY"] = ENCRYPTION_KEY;
  const { encryptSecret } = await import("@/lib/crypto/secret-box");
  const agent = await import("@/lib/ai/agent");
  return { agent, cipher: encryptSecret("k") };
}

/** 造一个内存工作区,断言文件真的被写进去了 */
function memoryWorkspace() {
  const files = new Map<string, string>();
  return {
    files,
    ctx: {
      async readFile(path: string) {
        return files.get(path) ?? null;
      },
      async writeFile(path: string, content: string) {
        files.set(path, content);
      },
      async listFiles(prefix: string | undefined) {
        return [...files.entries()]
          .filter(([p]) => (prefix ? p.startsWith(prefix) : true))
          .map(([p, c]) => ({ path: p, sizeChars: c.length }));
      },
    },
  };
}

/** 造一个返回固定序列的模型 */
function scriptedModel(
  turns: readonly {
    text?: string;
    calls?: { name: string; args: unknown }[];
  }[],
) {
  let i = 0;
  return vi.fn().mockImplementation(async () => {
    const turn = turns[Math.min(i, turns.length - 1)]!;
    i += 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: turn.text ?? "",
              tool_calls: (turn.calls ?? []).map((c, n) => ({
                id: `call_${i}_${n}`,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            },
            finish_reason: turn.calls?.length ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200 },
    );
  });
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

describe("智能体循环", () => {
  it("模型调 write_file 时,文件真的落进工作区", async () => {
    const { agent, cipher } = await load();
    const ws = memoryWorkspace();
    vi.stubGlobal(
      "fetch",
      scriptedModel([
        {
          calls: [
            {
              name: "write_file",
              args: { path: "src/app.ts", content: "export const a = 1;" },
            },
          ],
        },
        { text: "已经建好了入口文件。" },
      ]),
    );

    const r = await agent.runAgent({
      candidates: [candidate(cipher, "m")],
      userMessage: "建一个入口文件",
      history: [],
      toolContext: ws.ctx,
      signal: new AbortController().signal,
    });

    // 这一条是整件事的意义所在:代码不再只是气泡里的文本
    expect(ws.files.get("src/app.ts")).toBe("export const a = 1;");
    expect(r.answer).toBe("已经建好了入口文件。");
    expect(r.haltReason).toBeNull();
    vi.unstubAllGlobals();
  });

  it("步数到上限就停,并如实说明 —— 不能假装完成了", async () => {
    const { agent, cipher } = await load();
    const ws = memoryWorkspace();
    // 模型永远只调工具,不给最终答案 —— 典型的反复横跳
    vi.stubGlobal(
      "fetch",
      scriptedModel([
        { calls: [{ name: "list_files", args: {} }] },
      ]),
    );

    const r = await agent.runAgent({
      candidates: [candidate(cipher, "m")],
      userMessage: "干活",
      history: [],
      toolContext: ws.ctx,
      signal: new AbortController().signal,
      limits: {
        maxSteps: 3,
        budgetMs: 60_000,
        maxConsecutiveFailures: 99,
        stepTimeoutMs: 30_000,
      },
    });

    expect(r.steps).toHaveLength(3);
    expect(r.haltReason).toContain("步数上限");
    // 必须告诉用户已完成的部分在哪,否则他不知道该不该重来
    expect(r.haltReason).toContain("工作区");
    vi.unstubAllGlobals();
  });

  it("工具连续失败就停 —— 一直失败说明模型没在改正", async () => {
    const { agent, cipher } = await load();
    const ws = memoryWorkspace();
    // 路径穿越会被参数校验拒绝,模型却一直重试同一个
    vi.stubGlobal(
      "fetch",
      scriptedModel([
        {
          calls: [
            { name: "write_file", args: { path: "../escape.ts", content: "x" } },
          ],
        },
      ]),
    );

    const r = await agent.runAgent({
      candidates: [candidate(cipher, "m")],
      userMessage: "写个文件",
      history: [],
      toolContext: ws.ctx,
      signal: new AbortController().signal,
      limits: {
        maxSteps: 10,
        budgetMs: 60_000,
        maxConsecutiveFailures: 2,
        stepTimeoutMs: 30_000,
      },
    });

    expect(r.steps.length).toBeLessThanOrEqual(2);
    expect(r.haltReason).toContain("连续");
    // 路径穿越必须被挡住,一个字节都不能写出去
    expect(ws.files.size).toBe(0);
    vi.unstubAllGlobals();
  });

  it("模型既不调工具也不说话时,如实说明而不是给个空气泡", async () => {
    const { agent, cipher } = await load();
    const ws = memoryWorkspace();
    vi.stubGlobal("fetch", scriptedModel([{ text: "" }]));

    const r = await agent.runAgent({
      candidates: [candidate(cipher, "m")],
      userMessage: "干活",
      history: [],
      toolContext: ws.ctx,
      signal: new AbortController().signal,
    });

    expect(r.haltReason).toContain("不支持工具调用");
    vi.unstubAllGlobals();
  });

  it("临时性失败会换备用模型,不让一个 503 打死整轮", async () => {
    /**
     * 真实故障:智能体跑到一半,英伟达返回
     *   503 ResourceExhausted: Worker local total request limit reached (48/48)
     * 整轮直接结束,前面几步写好的文件用户完全不知道还在不在。
     * 普通对话早就有跨厂商降级,我写智能体循环时漏接了。
     */
    const { agent, cipher } = await load();
    const ws = memoryWorkspace();

    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          return new Response("ResourceExhausted: Worker limit reached", {
            status: 503,
          });
        }
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: "换了模型也办好了。" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200 },
        );
      }),
    );

    const r = await agent.runAgent({
      candidates: [candidate(cipher, "busy-model"), candidate(cipher, "backup-model", "备用服务商", "p2")],
      userMessage: "干活",
      history: [],
      toolContext: ws.ctx,
      signal: new AbortController().signal,
    });

    expect(r.answer).toBe("换了模型也办好了。");
    // 换过模型必须留痕 —— 悄悄换等于伪造来源
    expect(r.usedModels.join("、")).toContain("backup-model");
    vi.unstubAllGlobals();
  });

  it("永久性失败不浪费配额换模型 —— 换几次都一样", async () => {
    const { agent, cipher } = await load();
    const ws = memoryWorkspace();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("invalid api key", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agent.runAgent({
        candidates: [candidate(cipher, "m"), candidate(cipher, "a", "备用服务商", "p2"), candidate(cipher, "b", "备用服务商", "p2"), candidate(cipher, "c", "备用服务商", "p2")],
        userMessage: "干活",
        history: [],
        toolContext: ws.ctx,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();

    // 每家服务商只试一次,但不同的服务商都要试。
    //
    // 候选是 p1 一个 + p2 三个。401 是**整个服务商**级别的问题,
    // 同一把密钥换几个模型结果完全一样,所以 p2 的三个候选只烧一次调用;
    // 但 p1 的密钥失效绝不能成为「p2 也不试」的理由 —— 此前那样写会让
    // 一把过期的旧密钥把整个组织的对话能力全部堵死。
    // 所以期望是 2 次(两家各一次),不是 1 次也不是 4 次。
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("总结只列文件清单,不重复贴文件内容", async () => {
    const { agent } = await load();
    const summary = agent.summarizeRun({
      answer: "已完成登录页。",
      steps: [
        {
          index: 1,
          text: "",
          tools: [
            {
              callId: "c1",
              name: "write_file",
              ok: true,
              content: "已写入 src/login.tsx(2000 字符)。",
            },
          ],
        },
      ],
      inputTokens: 1,
      outputTokens: 1,
      haltReason: null,
      usedModels: [],
    });

    expect(summary).toContain("src/login.tsx");
    expect(summary).toContain("已完成登录页");
    // 把文件内容再贴一遍正是我们要消灭的行为
    expect(summary).not.toContain("2000 字符)");
  });
});
