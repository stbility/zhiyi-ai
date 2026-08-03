import { describe, expect, it, vi } from "vitest";

import { sseResponse } from "../helpers/sse";

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

/** 造一个返回固定序列的模型(流式 —— 与产品里的协议一致) */
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
    return sseResponse({
      ...(turn.text ? { content: turn.text } : {}),
      ...(turn.calls
        ? { toolCalls: turn.calls.map((c) => ({ name: c.name, args: c.args })) }
        : {}),
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
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
      model: candidate(cipher, "m"),
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
      model: candidate(cipher, "m"),
      userMessage: "干活",
      history: [],
      toolContext: ws.ctx,
      signal: new AbortController().signal,
      limits: {
        maxSteps: 3,
        budgetMs: 60_000,
        maxConsecutiveFailures: 99,
        maxRetries: 0,
      },
    });

    expect(r.steps).toHaveLength(3);
    expect(r.haltReason).toContain("步数上限");
    // 只陈述事实。「已完成的文件都在工作区里」这类话删掉了 ——
    // 它在一个文件都没写的运行里照样会打印,那就是纯粹的假话;
    // 写没写文件,工作区里一目了然。
    expect(r.haltReason).not.toMatch(/工作区|可以继续追问/);
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
      model: candidate(cipher, "m"),
      userMessage: "写个文件",
      history: [],
      toolContext: ws.ctx,
      signal: new AbortController().signal,
      limits: {
        maxSteps: 10,
        budgetMs: 60_000,
        maxConsecutiveFailures: 2,
        maxRetries: 0,
      },
    });

    expect(r.steps.length).toBeLessThanOrEqual(2);
    expect(r.haltReason).toContain("连续");
    // 路径穿越必须被挡住,一个字节都不能写出去
    expect(ws.files.size).toBe(0);
    vi.unstubAllGlobals();
  });

  it("模型既不调工具也不说话时,不编任何解释", async () => {
    const { agent, cipher } = await load();
    const ws = memoryWorkspace();
    vi.stubGlobal("fetch", scriptedModel([{ text: "" }]));

    const r = await agent.runAgent({
      model: candidate(cipher, "m"),
      userMessage: "干活",
      history: [],
      toolContext: ws.ctx,
      signal: new AbortController().signal,
    });

    // 这里曾写「可能是该模型不支持工具调用,或本轮被内容策略拦截」——
    // 两条都是猜测,而真实原因是我们自己把请求发成了非流式,
    // 用户照着那句话查了一星期。所以现在一个字都不编:
    // 空回答本身就是事实,排查线索在留痕与日志里。
    expect(r.haltReason).toBeNull();
    expect(r.answer).toBe("");
    vi.unstubAllGlobals();
  });

  it("临时失败会重试同一个模型 —— 但绝不换成别的模型", async () => {
    const { agent, cipher } = await load();
    const ws = memoryWorkspace();
    const 打过的模型: string[] = [];
    const fetchMock = vi.fn().mockImplementation((_u: string, init: { body: string }) => {
      打过的模型.push((JSON.parse(init.body) as { model: string }).model);
      return Promise.resolve(
        new Response("ResourceExhausted: Worker limit reached", { status: 503 }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agent.runAgent({
        model: candidate(cipher, "busy-model"),
        userMessage: "干活",
        history: [],
        toolContext: ws.ctx,
        signal: new AbortController().signal,
        // 退避是真的会 sleep,测试里只重试两次,够证明「重试了」且不拖慢
        limits: { maxSteps: 3, budgetMs: 60_000, maxConsecutiveFailures: 3, maxRetries: 2 },
      }),
    ).rejects.toThrow();

    // 重试了 —— 这是 Claude Code 官方文档写明的行为:
    // 「Claude Code retries these failures: Server errors, overloaded
    //   responses, and request timeouts」,默认 10 次,退避重试用尽之前
    // 根本不把错误给用户看。
    // 此前我们收到 529 就把整轮打死,十几步的活全毁 —— 那正是官方仓库
    // issue #60577 记的缺陷。
    expect(打过的模型.length, "一次都没重试").toBe(3); // 首次 + 2 次重试

    // 但**打的自始至终是同一个模型**。
    // 重试同一个 ≠ 换一个。用户说的是「你选哪个就用哪个,不换」,
    // 换模型才违背它,继续试不违背。
    expect(new Set(打过的模型)).toEqual(new Set(["busy-model"]));
    vi.unstubAllGlobals();
  });

  it("连接断在开口之前 —— 重发,这是 Claude 明确要求重试的一类", async () => {
    const { agent, cipher } = await load();
    const ws = memoryWorkspace();

    // 一个字都没吐就断 —— 「before any part of Claude's response has completed」
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("connection reset by peer"));
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await agent
      .runAgent({
        model: candidate(cipher, "m"),
        userMessage: "干活",
        history: [],
        toolContext: ws.ctx,
        signal: new AbortController().signal,
        limits: { maxSteps: 3, budgetMs: 60_000, maxConsecutiveFailures: 3, maxRetries: 2 },
      })
      .catch(() => undefined);

    // 这是上面那条 emitted 规则的**正向对照**:同样是流中断,
    // 区别只在断之前有没有吐过东西。没吐过 → 必须重发。
    //
    // 此前不会重发,而且原因很隐蔽:断连抛的是原始 Error,被一律包成
    // 「调用模型服务失败。」,消息和状态码全丢,于是判成永久性失败。
    expect(fetchMock, "断连没有被重试").toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("已经吐出过内容就不重发 —— 否则同一个 write_file 会执行两遍", async () => {
    const { agent, cipher } = await load();
    const ws = memoryWorkspace();

    // 和上一条**只差一点**:断之前先吐了一段正文。
    // 上一条会重发 3 次,这一条必须只发 1 次 —— 这一对构成正反对照,
    // 少了任何一边,「不重发」这个断言都可能因为别的原因碰巧成立
    // (它已经骗过我一次:当时断连被误判成永久性失败,
    //  于是 emitted 这道闸门根本没被走到,测试却是绿的)。
    let 吐过 = false;
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          // 必须分两次 pull:controller.error() 会**丢弃队列里已入队的数据**,
          // 写成 start() 里 enqueue 完立刻 error,那段正文根本送不到消费者手上,
          // 于是 emitted 永远是 false —— 这条测试就会因为完全错误的理由变绿。
          // (它确实这么骗过我一次。)
          new ReadableStream({
            pull(c) {
              if (吐过) {
                c.error(new Error("connection reset by peer"));
                return;
              }
              吐过 = true;
              c.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"我开始写"}}]}\n\n',
                ),
              );
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await agent
      .runAgent({
        model: candidate(cipher, "m"),
        userMessage: "干活",
        history: [],
        toolContext: ws.ctx,
        signal: new AbortController().signal,
        limits: { maxSteps: 3, budgetMs: 60_000, maxConsecutiveFailures: 3, maxRetries: 5 },
      })
      .catch(() => undefined);

    // Claude 官方把这条列在「不重试」里,理由是我猜不到的:
    //   「Claude Code could execute the same tool calls twice if it re-ran
    //    the request, so it keeps the completed output and ends the turn
    //    with an incomplete-response notice.」
    // 重发一个已经开始产出的请求,会让同一个 write_file 写两遍。
    // 宁可这一轮不完整,也不能把文件写重。
    expect(fetchMock, "已经吐过内容还重发了 —— 工具会被执行两遍").toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("永久性失败一次都不重试 —— 密钥错了重试多少次都一样", async () => {
    const { agent, cipher } = await load();
    const ws = memoryWorkspace();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("invalid api key", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agent.runAgent({
        model: candidate(cipher, "m"),
        userMessage: "干活",
        history: [],
        toolContext: ws.ctx,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("第一步强制动工具,之后放开 —— 否则模型可以整轮不碰工作区", async () => {
    const { agent, cipher } = await load();
    const files = new Map<string, string>();
    const 每步的选择: unknown[] = [];

    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_u: string, init: { body: string }) => {
        每步的选择.push((JSON.parse(init.body) as { tool_choice: unknown }).tool_choice);
        call += 1;
        return Promise.resolve(
          call === 1
            ? sseResponse({
                toolCalls: [
                  {
                    id: "c1",
                    name: "write_file",
                    args: { path: "src/a.ts", content: "export const a = 1;" },
                  },
                ],
              })
            : sseResponse({ content: "写好了。" }),
        );
      }),
    );

    const r = await agent.runAgent({
      model: candidate(cipher, "m"),
      userMessage: "建一个入口文件",
      history: [],
      toolContext: {
        async readFile(p: string) {
          return files.get(p) ?? null;
        },
        async writeFile(p: string, c: string) {
          files.set(p, c);
        },
        async listFiles() {
          return [];
        },
      },
      signal: new AbortController().signal,
    });

    // 第一步必须是 required。
    //
    // "auto" 允许模型完全无视工具,而它真的会:一次真实运行里,模型收到
    // 全套文件工具、系统提示词第一句就是「任何产物都必须用 write_file
    // 写进工作区」,它照样花 40 秒写了 1196 token 散文,工作区 0 文件。
    // 产物贴在正文里,用户还要手工复制粘贴 —— 那等于没做。
    expect(每步的选择[0], "第一步没有强制动工具").toBe("required");

    // 之后必须放开,否则模型永远收不了尾 ——
    // 「这一轮不调工具」正是它宣告任务完成的方式。
    expect(每步的选择[1], "第二步还在强制,模型将无法收尾").toBe("auto");

    expect(files.get("src/a.ts")).toBe("export const a = 1;");
    expect(r.answer).toBe("写好了。");
    // 亲眼见过 tool_calls —— 这是「支持工具调用」唯一算数的正面证据
    expect(r.toolSupport).toBe("observed");
    vi.unstubAllGlobals();
  });

  it("服务商拒绝 required 时先摘掉强制,而不是判它不支持工具", async () => {
    const { agent, cipher } = await load();
    const 每步的选择: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_u: string, init: { body: string }) => {
        const choice = (JSON.parse(init.body) as { tool_choice: unknown }).tool_choice;
        每步的选择.push(choice);
        // 只拒绝 required 这个取值,tools 本身是接受的
        if (choice === "required") {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: { message: "unsupported value for tool_choice" } }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(sseResponse({ content: "我直接答了。" }));
      }),
    );

    const r = await agent.runAgent({
      model: candidate(cipher, "m"),
      userMessage: "干活",
      history: [],
      toolContext: {
        async readFile() {
          return null;
        },
        async writeFile() {},
        async listFiles() {
          return [];
        },
      },
      signal: new AbortController().signal,
    });

    // 退让必须分两步,顺序不能反:
    // 有的服务商支持 tools,只是不认 "required" 这个取值。这时它其实
    // 能调工具 —— 直接判它「不支持工具调用」会把一个好好的模型拉黑。
    expect(每步的选择[0]).toBe("required");
    expect(每步的选择[1]).toBe("auto");
    expect(r.answer).toBe("我直接答了。");
    // 拒的是 required,不是 tools —— 所以**不能**留下否定结论
    expect(r.toolSupport, "把「不认 required」误判成了「不支持工具」").not.toBe(
      "rejected",
    );
    vi.unstubAllGlobals();
  });

  it("总结只回模型自己说的话,不由系统拼叙述", async () => {
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
      haltReason: "已达到步数上限(12 步)。",
      toolSupport: null,
    });

    // 只剩模型说的那句话。系统不再往里拼任何东西 ——
    // 写了几个文件、换过哪些模型、为什么停下,那些是旁白不是回答。
    // 事实没丢:产物在工作区看得见,用过哪个模型 messages.model_id 记着。
    expect(summary).toBe("已完成登录页。");
    expect(summary).not.toContain("src/login.tsx");
    // 护栏原因也不进正文 —— 它走 SSE 的 error 通道,由界面在错误位置渲染,
    // 而不是伪装成模型说的话
    expect(summary).not.toContain("步数上限");
    expect(summary).not.toContain("本次");
  });
});
