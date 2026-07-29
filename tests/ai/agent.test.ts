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

const creds = (cipher: string) => ({
  kind: "openai_compatible" as const,
  baseUrl: "https://api.example.com/v1",
  apiKeyCipher: cipher,
});

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
      credentials: creds(cipher),
      model: "m",
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
      credentials: creds(cipher),
      model: "m",
      userMessage: "干活",
      history: [],
      toolContext: ws.ctx,
      signal: new AbortController().signal,
      limits: { maxSteps: 3, budgetMs: 60_000, maxConsecutiveFailures: 99 },
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
      credentials: creds(cipher),
      model: "m",
      userMessage: "写个文件",
      history: [],
      toolContext: ws.ctx,
      signal: new AbortController().signal,
      limits: { maxSteps: 10, budgetMs: 60_000, maxConsecutiveFailures: 2 },
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
      credentials: creds(cipher),
      model: "m",
      userMessage: "干活",
      history: [],
      toolContext: ws.ctx,
      signal: new AbortController().signal,
    });

    expect(r.haltReason).toContain("不支持工具调用");
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
    });

    expect(summary).toContain("src/login.tsx");
    expect(summary).toContain("已完成登录页");
    // 把文件内容再贴一遍正是我们要消灭的行为
    expect(summary).not.toContain("2000 字符)");
  });
});
