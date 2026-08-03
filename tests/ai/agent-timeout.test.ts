import { describe, expect, it, vi } from "vitest";

import { sseResponse } from "../helpers/sse";

/**
 * 智能体的超时与预算。
 *
 * 这组测试守的是「智能体无法正常工作」的根因。
 *
 * 对话路径有四层防护(首片 45 秒、停滞 60 秒、总预算 285 秒、吞吐下限),
 * 而智能体路径此前**一层都没有** —— callWithTools 是非流式的,上游不回
 * 就一个字节都收不到,而它只拿到了客户端的 abort 信号。
 *
 * 实际后果(生产实测):服务商容量塌陷时 15 秒才挤出一个 token,
 * 一步就能把整个函数挂到 Vercel 的 300 秒上限被强杀 —— 连接直接断开,
 * 浏览器只报「Failed to fetch」。智能体的 budgetMs 救不了,
 * 因为它只在每步**开始前**判断,拦不住一个已经挂住的 fetch。
 */

const ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");

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

/** 一个永远不返回的上游 —— 只有传进来的 signal 能把它中止 */
function hangingFetch() {
  return vi.fn().mockImplementation(
    (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(
            Object.assign(new Error("aborted"), { name: "AbortError" }),
          ),
        );
      }),
  );
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

describe("智能体单步超时", () => {
  it("上游一直不返回时,按 timeoutMs 中止,而不是无限挂着", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal("fetch", hangingFetch());

    const started = Date.now();
    await expect(
      gateway.callWithTools({
        credentials: creds(cipher),
      model: "slow-model",
        messages: [{ role: "user", content: "写个文件" }],
        tools: [],
        signal: new AbortController().signal,
        timeoutMs: 150,
      }),
    ).rejects.toThrow(/时间已用完|尚未返回/);

    // 真的是被超时切断的,不是等到天荒地老
    expect(Date.now() - started).toBeLessThan(3_000);
    vi.unstubAllGlobals();
  });

  it("超时报 504 —— 必须落进「临时故障」,降级链才会换模型", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal("fetch", hangingFetch());

    const err = await gateway
      .callWithTools({
        credentials: creds(cipher),
      model: "slow-model",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
        timeoutMs: 100,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(gateway.ProviderCallError);
    const status = (err as { status?: number }).status;
    expect(status).toBe(504);

    // 这一条是超时能自愈的关键:判定为临时故障,智能体才会换下一个模型,
    // 而不是把整次运行判死
    const { isTransientFailure } = await import(
      "@/lib/providers/model-filter"
    );
    expect(isTransientFailure(status, (err as Error).message)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("客户端自己断开时,不谎称是模型超时", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal("fetch", hangingFetch());

    const controller = new AbortController();
    const promise = gateway.callWithTools({
      credentials: creds(cipher),
      model: "m",
      messages: [],
      tools: [],
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    controller.abort();

    const err = await promise.catch((e: unknown) => e);
    // 是原始的 AbortError 透传上去,而不是被包装成「模型太慢」——
    // 没人在等回复,不该编一个模型的问题出来
    expect((err as Error).name).toBe("AbortError");
    vi.unstubAllGlobals();
  });

  it("主模型快速失败时,自动换备用模型并把活干完", async () => {
    // 这条是「智能体能正常工作」的定义。
    //
    // 注意用的是**快速失败**(503)而不是挂住不返回:单步超时取消固定上限
    // 之后,界限只剩「本次运行还剩多少时间」—— 一个真正挂住的上游会把整个
    // 预算吃光,后面的候选连启动的机会都没有。这是刻意的取舍:原来那个
    // 120 秒固定上限比模型的正常工作时间(生产实测 100~154 秒)还短,
    // 会误杀四分之一的正常请求,代价比「挂死时没有备用」大得多。
    //
    // 而真实世界里绝大多数服务商故障是快速失败的(503 排队、401 密钥、
    // 404 模型不存在),那些情况下降级链照常工作 —— 这条测的就是它。
    const { agent, cipher } = await load();
    const files = new Map<string, string>();

    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: { body: string; signal: AbortSignal }) => {
          const model = (JSON.parse(init.body) as { model: string }).model;
          // slow 立刻回 503(排队)—— 服务商故障最常见的形态
          if (model === "slow") {
            return Promise.resolve(
              new Response("ResourceExhausted: Worker limit reached", {
                status: 503,
              }),
            );
          }
          // good 正常干活:先写文件,再收尾
          call += 1;
          return Promise.resolve(
            call === 1
              ? sseResponse({
                  toolCalls: [
                    {
                      id: "c1",
                      name: "write_file",
                      args: { path: "src/app.ts", content: "export const a = 1;" },
                    },
                  ],
                })
              : sseResponse({ content: "写好了。" }),
          );
        },
      ),
    );

    const r = await agent.runAgent({
      candidates: [candidate(cipher, "slow"), candidate(cipher, "good", "备用服务商", "p2")],
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
      limits: {
        maxSteps: 5,
        budgetMs: 20_000,
        maxConsecutiveFailures: 3,
      },
    });

    // 任务真的完成了:文件落地、有收尾回答、没有撞任何护栏
    expect(files.get("src/app.ts")).toBe("export const a = 1;");
    expect(r.answer).toBe("写好了。");
    expect(r.haltReason).toBeNull();
    // 换过模型必须如实告知 —— 悄悄换等于伪造来源。
    // 现在连**换到了哪一家服务商**也一并说清楚:跨服务商降级之后,
    // 只说模型名不够 —— 用户需要知道这次回答其实是别家跑的。
    expect(r.usedModels.join("、")).toContain("good");
    expect(r.usedModels.join("、")).toContain("备用服务商");
    vi.unstubAllGlobals();
  });

  it("单步超时被剩余预算收窄,不会几个候选各给一份满额", async () => {
    const { agent, cipher } = await load();
    const seen: number[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_r, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            );
          }),
      ),
    );

    // 直接观察传给 callWithTools 的 timeoutMs:总预算 300ms,
    // 单步上限 120 秒 —— 生效值必须是前者,否则一个候选就能吃光整次运行
    const gateway = await import("@/lib/ai/gateway");
    vi.spyOn(gateway, "callWithTools").mockImplementation(
      async (args: Parameters<typeof gateway.callWithTools>[0]) => {
        seen.push(args.timeoutMs);
        throw new gateway.ProviderCallError("排队中,请稍后重试", 503);
      },
    );

    await agent
      .runAgent({
        candidates: [candidate(cipher, "a"), candidate(cipher, "b", "备用服务商", "p2"), candidate(cipher, "c", "备用服务商", "p2")],
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
        limits: {
          maxSteps: 3,
          budgetMs: 300,
          maxConsecutiveFailures: 3,
        },
      })
      .catch(() => undefined);

    expect(seen.length).toBeGreaterThan(0);
    // 每一次都不超过总预算 —— 单步不再另设固定上限,界限只有「还剩多少时间」
    for (const t of seen) expect(t).toBeLessThanOrEqual(300);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

/**
 * 响应头已到、响应体挂住。
 *
 * 上面那组测的是 fetch 本身挂住。但 fetch 在**响应头**到达时就 resolve 了 ——
 * 上游完全可能先回 200,body 却迟迟不发完。这在服务商容量塌陷时很常见,
 * 而它恰恰是这次修复要解决的场景本身。
 *
 * 只把 fetch 包进超时保护是不够的:那种情况下超时会在读 body 时触发,
 * 抛出的是裸 AbortError —— 没有 504,isTransientFailure 看不到 5xx,
 * 降级链就不会换模型,于是又挂回原来的老路。
 */
describe("流挂住", () => {
  /** 响应头已到,但**流**一个字节都不发 —— 上游「先回头、body 不来」的真实形态 */
  function stalledStreamFetch() {
    return vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                const fail = () =>
                  controller.error(
                    Object.assign(new Error("aborted"), { name: "AbortError" }),
                  );
                // 必须先判 aborted:信号可能在这之前就已中止,
                // 而对已中止的信号挂监听器永远不会触发
                if (init.signal.aborted) fail();
                else init.signal.addEventListener("abort", fail);
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        ),
    );
  }

  it("超时抛 504,降级链才会接手换模型", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal("fetch", stalledStreamFetch());

    const err = await gateway
      .callWithTools({
        credentials: creds(cipher),
        model: "slow",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        signal: new AbortController().signal,
        timeoutMs: 60,
      })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(gateway.ProviderCallError);
    const call = err as InstanceType<typeof gateway.ProviderCallError>;
    // 504 落在 isTransientFailure 的 >=500 分支,降级链据此换模型。
    // fetch 在**响应头**到达时就 resolve 了,所以只把 fetch 包进 try 不够 ——
    // 流挂住时超时是在读流的过程中触发的
    expect(call.status).toBe(504);

    const { isTransientFailure } = await import("@/lib/providers/model-filter");
    expect(isTransientFailure(call.status, call.message)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("客户端自己断开时原样透传,不编一个「模型太慢」出来", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal("fetch", stalledStreamFetch());

    const controller = new AbortController();
    const promise = gateway
      .callWithTools({
        credentials: creds(cipher),
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        signal: controller.signal,
        timeoutMs: 10_000,
      })
      .then(() => null)
      .catch((e: unknown) => e);

    controller.abort();
    const err = await promise;

    // 没人在等回复,不该被包装成一句关于模型速度的解释
    expect(err).not.toBeInstanceOf(gateway.ProviderCallError);
    vi.unstubAllGlobals();
  });

  it("流里塞了错误载荷时不得吞掉 —— 上游用 HTTP 200 报错是常见做法", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `data: ${JSON.stringify({ error: { message: "rate limit exceeded" } })}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );

    const err = await gateway
      .callWithTools({
        credentials: creds(cipher),
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      })
      .then(() => null)
      .catch((e: unknown) => e);

    // 静默吞掉的话,表现是「模型什么都没说」—— 排查时毫无线索
    expect(err).toBeInstanceOf(gateway.ProviderCallError);
    expect((err as Error).message).toMatch(/限流|rate/i);
    vi.unstubAllGlobals();
  });
});
