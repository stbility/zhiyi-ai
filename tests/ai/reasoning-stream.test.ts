import { describe, expect, it, vi } from "vitest";

/**
 * 推理模型的思考过程必须实时流出来。
 *
 * 真实故障:用户报「模型不工作」。数据库里的证据是
 *   输出 17474 token,正文只有 1001 字
 *   输出 2689 token,正文只有 84 字
 *   等待 298 秒,正文 47 字
 * 绝大部分内容进了 reasoning_content,而它被整段缓冲,
 * 只在「完全没有正文」时才吐出来。两个后果:
 *
 *   1. 模型思考的几分钟里前端一个字都收不到,界面看起来是死的
 *   2. 看门狗只在收到增量时重新计时 —— 模型正常推理却被判成
 *      「45 秒内没有返回任何内容」而掐断
 *
 * 所以流必须区分 content 与 reasoning:两者都要实时产出,
 * 但只有 content 计入答案。
 */

function sse(chunks: readonly unknown[]): Response {
  const body = chunks
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  vi.doMock("@/lib/crypto/secret-box", () => ({
    decryptSecret: () => "test-key",
  }));
  return import("@/lib/ai/gateway");
}

const CREDS = {
  kind: "openai_compatible" as const,
  baseUrl: "https://example.test/v1",
  apiKeyCipher: "cipher",
};

describe("推理流", () => {
  it("思考过程实时产出,且与正文分开", async () => {
    vi.stubGlobal("fetch", async () =>
      sse([
        { choices: [{ delta: { reasoning_content: "先想一下…" } }] },
        { choices: [{ delta: { reasoning_content: "再想一下…" } }] },
        { choices: [{ delta: { content: "答案是 42" } }] },
      ]),
    );

    const { streamChat } = await load();
    const r = await streamChat({
      credentials: CREDS,
      model: "m",
      messages: [{ role: "user", content: "问题" }],
      signal: new AbortController().signal,
    });

    const got: { kind: string; text: string }[] = [];
    for await (const c of r.stream) got.push({ kind: c.kind, text: c.text });

    // 思考过程必须在正文之前就已经流出来,而不是攒到最后
    expect(got.map((g) => g.kind)).toEqual([
      "reasoning",
      "reasoning",
      "content",
    ]);
    // 只有 content 才是答案
    expect(
      got.filter((g) => g.kind === "content").map((g) => g.text).join(""),
    ).toBe("答案是 42");
  });

  it("整轮只有思考、没有正文时,把思考作为正文交出去 —— 不能给空气泡", async () => {
    vi.stubGlobal("fetch", async () =>
      sse([{ choices: [{ delta: { reasoning_content: "想了很久" } }] }]),
    );

    const { streamChat } = await load();
    const r = await streamChat({
      credentials: CREDS,
      model: "m",
      messages: [{ role: "user", content: "问题" }],
      signal: new AbortController().signal,
    });

    const got: { kind: string; text: string }[] = [];
    for await (const c of r.stream) got.push({ kind: c.kind, text: c.text });

    const content = got.filter((g) => g.kind === "content");
    expect(content.length).toBe(1);
    expect(content[0]!.text).toContain("想了很久");
    // 要说清这是思考过程,不能冒充成正式回答
    expect(content[0]!.text).toContain("没有产出正式回答");
  });

  it("普通模型不受影响 —— 只有正文,没有多余事件", async () => {
    vi.stubGlobal("fetch", async () =>
      sse([
        { choices: [{ delta: { content: "你" } }] },
        { choices: [{ delta: { content: "好" } }] },
      ]),
    );

    const { streamChat } = await load();
    const r = await streamChat({
      credentials: CREDS,
      model: "m",
      messages: [{ role: "user", content: "问题" }],
      signal: new AbortController().signal,
    });

    const got: { kind: string; text: string }[] = [];
    for await (const c of r.stream) got.push({ kind: c.kind, text: c.text });

    expect(got).toEqual([
      { kind: "content", text: "你" },
      { kind: "content", text: "好" },
    ]);
  });
});

/**
 * 探测只能认正文。
 *
 * 真实回归:改成 StreamChunk 之后,probeChatModel 里仍写着 text += delta,
 * 而 delta 是对象 —— 拼出来是 "[object Object]",于是**任何**分片都能让
 * 探测判定通过,包括纯思考过程的分片。explainEmptyResponse 那条分支
 * 永远走不到,而它的存在意义正是「不要把跑不通的模型当成可用」。
 * TypeScript 允许 string += object,所以类型检查和 253 个测试全都放过了。
 */
describe("模型探测", () => {
  it("只有思考、没有正文时,判定为不可用", async () => {
    vi.stubGlobal("fetch", async () =>
      sse([{ choices: [{ delta: { reasoning_content: "在想…" } }] }]),
    );
    const { probeChatModel } = await load();
    const r = await probeChatModel({
      credentials: CREDS,
      model: "m",
      timeoutMs: 5000,
      attempts: 1,
    });
    expect(r.ok).toBe(false);
    // 不能出现对象被当字符串拼接的痕迹
    expect(JSON.stringify(r)).not.toContain("[object Object]");
  });

  it("有正文时判定为可用", async () => {
    vi.stubGlobal("fetch", async () =>
      sse([{ choices: [{ delta: { content: "在的" } }] }]),
    );
    const { probeChatModel } = await load();
    const r = await probeChatModel({
      credentials: CREDS,
      model: "m",
      timeoutMs: 5000,
      attempts: 1,
    });
    expect(r.ok).toBe(true);
  });
});
