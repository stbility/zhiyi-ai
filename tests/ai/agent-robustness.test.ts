import { describe, expect, it, vi } from "vitest";

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

function jsonOnce(payload: unknown) {
  return vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
}

describe("推理模型只给 reasoning_content 时", () => {
  it("content 是空串也要回退到思考过程,不能判成「什么都没说」", async () => {
    const { gateway, cipher } = await load();
    // 关键在于 content 是 ""(空字符串)而不是 null ——
    // 用 ?? 回退的话空串会被原样返回,思考过程整段丢掉
    vi.stubGlobal(
      "fetch",
      jsonOnce({
        choices: [
          {
            message: { content: "", reasoning_content: "我先看看目录结构。" },
            finish_reason: "stop",
          },
        ],
      }),
    );

    const turn = await gateway.callWithTools({
      credentials: creds(cipher),
      model: "reasoner",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });

    expect(turn.text).toBe("我先看看目录结构。");
    vi.unstubAllGlobals();
  });

  it("有正文时不受影响,仍然取正文", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal(
      "fetch",
      jsonOnce({
        choices: [
          {
            message: { content: "答案在这里", reasoning_content: "思考…" },
            finish_reason: "stop",
          },
        ],
      }),
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
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: {
                        name: "write_file",
                        // 残缺的 JSON —— 正是被长度截断的典型表现
                        arguments: '{"path":"a.ts","content":"export cons',
                      },
                    },
                  ],
                },
                finish_reason: "length",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const r = await agent.runAgent({
      credentials: creds(cipher),
      model: "m",
      userMessage: "写个大文件",
      history: [],
      toolContext: memoryTools(),
      signal: new AbortController().signal,
      limits: {
        maxSteps: 12,
        budgetMs: 60_000,
        maxConsecutiveFailures: 3,
        stepTimeoutMs: 10_000,
      },
    });

    expect(r.haltReason).toMatch(/长度上限截断/);
    // 必须给出可执行的下一步,而不是只说「失败了」
    expect(r.haltReason).toMatch(/拆小|换一个/);
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
