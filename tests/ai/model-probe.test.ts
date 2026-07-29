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
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain("排队");
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
