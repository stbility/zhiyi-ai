import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 模型可用性探测测试。
 *
 * 用户的红线是「不要写伪模型」。做到这一点的唯一办法,是每个模型进入
 * 选择列表之前都真调一次 —— /models 说「看得到」不等于「用得了」。
 *
 * 这些断言保证探测的判定是可信的:真回了内容才算通过,回空、报错、
 * 超时都要算失败并说出原因。判错方向的代价是不对称的 ——
 * 误判为可用会让用户点开一个坏模型,那正是要杜绝的情况。
 */

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  const { encryptSecret } = await import("@/lib/crypto/secret-box");
  const gateway = await import("@/lib/ai/gateway");
  return { gateway, cipher: encryptSecret("test-key-not-real") };
}

/** 拼一段 OpenAI 兼容的 SSE 响应 */
function sse(events: readonly string[]): Response {
  const body = events.map((e) => `data: ${e}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const delta = (text: string) =>
  JSON.stringify({ choices: [{ delta: { content: text } }] });

describe("模型可用性探测", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("真的回了内容 → 判定可用", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sse([delta("你"), delta("好")])),
    );

    const r = await gateway.probeChatModel({
      credentials: {
        kind: "openai_compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyCipher: cipher,
      },
      model: "z-ai/glm-5.2",
      timeoutMs: 5_000,
    });

    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.model).toBe("z-ai/glm-5.2");
  });

  it("返回 404 → 判定不可用,原因指向接口或模型名", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not found", { status: 404 })),
    );

    const r = await gateway.probeChatModel({
      credentials: {
        kind: "openai_compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyCipher: cipher,
      },
      model: "baai/bge-m3",
      timeoutMs: 5_000,
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain("404");
  });

  it("200 但一个字都没有 → 判定不可用,不能当成功", async () => {
    const { gateway, cipher } = await load();
    // 只有 role,没有 content —— 这正是之前被当成「成功但内容为空」存下来的情况
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          sse([JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })]),
        ),
    );

    const r = await gateway.probeChatModel({
      credentials: {
        kind: "openai_compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyCipher: cipher,
      },
      model: "some/model",
      timeoutMs: 5_000,
    });

    expect(r.ok).toBe(false);
    expect(r.reason).not.toBeNull();
    expect(r.reason!.length).toBeGreaterThan(8);
  });

  it("上游排队不回应 → 超时判定不可用,并说清是排队", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );

    const r = await gateway.probeChatModel({
      credentials: {
        kind: "openai_compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyCipher: cipher,
      },
      model: "deepseek-ai/deepseek-v4-pro",
      timeoutMs: 150,
      attempts: 1,
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain("排队");
    // 排队是容量问题,模型本身没坏 —— 判成临时才不会被永久剔除
    expect(r.transient).toBe(true);
  });

  it("临时故障会重试 —— 一次堵车不该决定一条路的存废", async () => {
    const { gateway, cipher } = await load();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls += 1;
        // 前两次排队,第三次通了。真实的排队就是这个样子。
        return Promise.resolve(
          calls < 3
            ? new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
                status: 429,
              })
            : sse([delta("你好")]),
        );
      }),
    );

    const r = await gateway.probeChatModel({
      credentials: {
        kind: "openai_compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyCipher: cipher,
      },
      model: "deepseek-ai/deepseek-v4-flash",
      timeoutMs: 5_000,
      attempts: 3,
      backoffMs: 1,
    });

    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("永久故障不重试 —— 模型下线了,再试一百次还是下线", async () => {
    const { gateway, cipher } = await load();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await gateway.probeChatModel({
      credentials: {
        kind: "openai_compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyCipher: cipher,
      },
      model: "deepseek-ai/deepseek-coder-6.7b-instruct",
      timeoutMs: 5_000,
      attempts: 3,
      backoffMs: 1,
    });

    expect(r.ok).toBe(false);
    expect(r.transient).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("上游对失败的原话会被带出来,而不是只剩一句固定文案", async () => {
    const { gateway, cipher } = await load();
    // 真实教训:kimi-k2.6 的标识与端点都和官方文档一致却报 404,
    // 而我们除了「模型不存在」什么都说不出来,根本无从排查。
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ detail: "Model is not available for your account tier" }),
          { status: 404 },
        ),
      ),
    );

    const r = await gateway.probeChatModel({
      credentials: {
        kind: "openai_compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyCipher: cipher,
      },
      model: "moonshotai/kimi-k2.6",
      timeoutMs: 5_000,
      attempts: 1,
    });

    expect(r.reason).toContain("Model is not available for your account tier");
  });

  it("上游原话里形似密钥的串会被擦掉 —— 错误信息也可能泄密", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: "Invalid key nvapi-abcdefgh12345678xyz provided",
          }),
          { status: 401 },
        ),
      ),
    );

    const r = await gateway.probeChatModel({
      credentials: {
        kind: "openai_compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyCipher: cipher,
      },
      model: "z-ai/glm-5.2",
      timeoutMs: 5_000,
      attempts: 1,
    });

    expect(r.reason).not.toContain("nvapi-abcdefgh12345678xyz");
    expect(r.reason).toContain("已隐去");
  });

  it("探测拿到内容就中止上游,不把整段回复读完 —— 省配额", async () => {
    const { gateway, cipher } = await load();
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return Promise.resolve(sse([delta("你好"), delta(",很高兴"), delta("认识你")]));
      }),
    );

    await gateway.probeChatModel({
      credentials: {
        kind: "openai_compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyCipher: cipher,
      },
      model: "moonshotai/kimi-k2.6",
      timeoutMs: 5_000,
    });

    expect(aborted).toBe(true);
  });
});
