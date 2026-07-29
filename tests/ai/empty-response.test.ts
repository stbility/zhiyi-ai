import { describe, expect, it, vi } from "vitest";

/**
 * 「上游返回 200 却没有内容」的解释测试。
 *
 * 真实故障:NVIDIA 接口第一轮正常回复,第二轮起返回 200 但流里没有正文,
 * 耗时仅 96–191ms。当时代码把它当成「成功但内容为空」存了下来 ——
 * 用户看到一个空气泡,数据库里 error_message 也是空的,完全无法排查。
 *
 * 这些断言保证:凡是没产出内容,必须给出一个能指导下一步的原因。
 */

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return import("@/lib/ai/gateway");
}

const base = {
  finishReason: null,
  streamError: null,
  seenDeltaKeys: [] as string[],
  chunkCount: 0,
};

describe("空回复的原因解释", () => {
  it("流内错误优先原样报出", async () => {
    const { explainEmptyResponse } = await load();
    const text = explainEmptyResponse({
      ...base,
      streamError: "model is overloaded",
      chunkCount: 1,
    });
    expect(text).toContain("model is overloaded");
  });

  it("一个分片都没收到时,指出模型可能不可用", async () => {
    const { explainEmptyResponse } = await load();
    const text = explainEmptyResponse({ ...base, chunkCount: 0 });
    expect(text).toContain("没有返回任何数据");
  });

  it("因长度上限截断时给出可操作建议", async () => {
    const { explainEmptyResponse } = await load();
    const text = explainEmptyResponse({
      ...base,
      finishReason: "length",
      chunkCount: 3,
    });
    expect(text).toContain("长度");
    expect(text).toContain("缩短输入");
  });

  it("被内容策略拦截时如实说明", async () => {
    const { explainEmptyResponse } = await load();
    const text = explainEmptyResponse({
      ...base,
      finishReason: "content_filter",
      chunkCount: 2,
    });
    expect(text).toContain("安全策略");
  });

  it("推理模型只吐思考过程时,指出换模型或重试", async () => {
    const { explainEmptyResponse } = await load();
    const text = explainEmptyResponse({
      ...base,
      seenDeltaKeys: ["reasoning_content", "role"],
      chunkCount: 20,
    });
    expect(text).toContain("推理过程");
  });

  it("兜底情况也要带上分片数与字段名,便于排查", async () => {
    const { explainEmptyResponse } = await load();
    const text = explainEmptyResponse({
      ...base,
      seenDeltaKeys: ["role"],
      chunkCount: 5,
    });
    expect(text).toContain("5");
    expect(text).toContain("role");
  });

  it("任何情况下都不会返回空字符串 —— 空原因等于没有原因", async () => {
    const { explainEmptyResponse } = await load();
    const cases = [
      base,
      { ...base, chunkCount: 1 },
      { ...base, finishReason: "stop", chunkCount: 1 },
      { ...base, seenDeltaKeys: ["content"], chunkCount: 9 },
    ];
    for (const c of cases) {
      expect(explainEmptyResponse(c).trim().length).toBeGreaterThan(8);
    }
  });
});

/**
 * 推理模型只吐思考过程时,不该报「没有内容」。
 *
 * 英伟达官方示例里有 extra_body={"chat_template_kwargs":{"thinking":False}},
 * 那是**关闭**推理模式的开关。不传它时,deepseek-v4-pro 这类模型可能整轮
 * 只产出 reasoning_content 而 content 始终为空 —— 此前我们只取 content,
 * 于是把它判成「返回 200 却没有内容」,用户看到一个空气泡,
 * 而模型其实是有输出的,只是放在了另一个字段里。
 *
 * 字段名 reasoning_content 是 DeepSeek、英伟达等多家共用的约定,
 * 所以按字段判断,不按服务商判断。
 */
describe("只有思考过程时的处理", () => {
  const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  async function loadWithCrypto() {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    process.env["ENCRYPTION_KEY"] = ENCRYPTION_KEY;
    const { encryptSecret } = await import("@/lib/crypto/secret-box");
    const gateway = await import("@/lib/ai/gateway");
    return { gateway, cipher: encryptSecret("test-key") };
  }

  function sse(events: readonly string[]): Response {
    const body =
      events.map((e) => `data: ${e}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, { status: 200 });
  }

  it("content 为空但有 reasoning_content 时,把思考过程交出来并标明", async () => {
    const { gateway, cipher } = await loadWithCrypto();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sse([
          JSON.stringify({
            choices: [{ delta: { reasoning_content: "先分析需求…" } }],
          }),
          JSON.stringify({
            choices: [{ delta: { reasoning_content: "再考虑边界。" } }],
          }),
        ]),
      ),
    );

    const { stream } = await gateway.streamChat({
      credentials: {
        kind: "openai_compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyCipher: cipher,
      },
      model: "deepseek-ai/deepseek-v4-pro",
      messages: [{ role: "user", content: "你好" }],
      signal: new AbortController().signal,
    });

    let text = "";
    for await (const d of stream) text += d;

    expect(text).toContain("先分析需求");
    expect(text).toContain("再考虑边界");
    // 必须说明这是思考过程,不能冒充正式回答
    expect(text).toContain("思考过程");
    vi.unstubAllGlobals();
  });

  it("有正文时不掺入思考过程 —— 思考不该混进给用户看的回答", async () => {
    const { gateway, cipher } = await loadWithCrypto();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sse([
          JSON.stringify({
            choices: [{ delta: { reasoning_content: "内部推演…" } }],
          }),
          JSON.stringify({ choices: [{ delta: { content: "答案是 42。" } }] }),
        ]),
      ),
    );

    const { stream } = await gateway.streamChat({
      credentials: {
        kind: "openai_compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyCipher: cipher,
      },
      model: "deepseek-ai/deepseek-v4-pro",
      messages: [{ role: "user", content: "你好" }],
      signal: new AbortController().signal,
    });

    let text = "";
    for await (const d of stream) text += d;

    expect(text).toBe("答案是 42。");
    expect(text).not.toContain("内部推演");
    vi.unstubAllGlobals();
  });
});
