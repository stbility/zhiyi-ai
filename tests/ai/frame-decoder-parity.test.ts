import { describe, expect, it, vi } from "vitest";

/**
 * 同一帧数据,两条通道必须给出同一个解释。
 *
 * gateway 里有两个消费者:
 *   streamChat           对话通道,逐段 yield
 *   assembleToolStream   智能体通道,拼成一次完整结果
 *
 * 它们的**累积方式**本就不同,那没问题。会出事的是**解释方式** ——
 * 此前两边各自把 chunk 解释了一遍,已经跑出一处真实分歧:
 *
 *   对话侧    error ?? detail   ← 三个字段都看
 *   智能体侧  error             ← 只看一个
 *
 * 后果是:用 detail 字段报错的服务商,在智能体这条线上会被**静默吞掉**,
 * 表现成「这一轮什么都没有」,而错误信息就在那一帧里。用户会以为是模型
 * 不干活,实际是我们把人家的报错扔了。
 *
 * 这正是「stream: false 拖了一星期」那个事故的同一形态:协议的两端各自
 * 演化,测试各测各的,直到生产暴露。所以这里用**同一批夹具喂两条通道**,
 * 断言它们的结论一致 —— 光测其中一条,分歧永远发现不了。
 */

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  process.env["ENCRYPTION_KEY"] = Buffer.alloc(32, 9).toString("base64");
  const { encryptSecret } = await import("@/lib/crypto/secret-box");
  const gateway = await import("@/lib/ai/gateway");
  return {
    gateway,
    credentials: {
      kind: "openai_compatible" as const,
      baseUrl: "https://api.example.com/v1",
      apiKeyCipher: encryptSecret("k"),
    },
  };
}

const sseResponse = (body: string) =>
  new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

/** 流内错误的三种写法 —— 各家服务商用哪个的都有 */
const 错误帧 = [
  ["error 是字符串", '{"error":"quota exhausted"}'],
  ["error.message", '{"error":{"message":"upstream boom"}}'],
  // 这一条是真实分歧所在:智能体侧此前只看 error,不看 detail
  ["detail 字段", '{"detail":"model is overloaded"}'],
] as const;

describe("流内错误:两条通道都不许吞,而且结论必须一样", () => {
  /** 把同一帧分别喂给两条通道,返回各自的结果 */
  async function 两边跑(帧: string) {
    const a = await load();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(`data: ${帧}\n\n`)));
    const r = await a.gateway.streamChat({
      credentials: a.credentials,
      model: "m",
      messages: [{ role: "user", content: "q" }],
      signal: new AbortController().signal,
    });
    const 对话 = await (async () => {
      try {
        for await (const _ of r.stream) void _;
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    })();
    vi.unstubAllGlobals();

    const b = await load();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(`data: ${帧}\n\n`)));
    const 智能体 = await b.gateway
      .callWithTools({
        credentials: b.credentials,
        model: "m",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      })
      .then(() => null)
      .catch((e: unknown) => (e as Error).message);
    vi.unstubAllGlobals();

    return { 对话, 智能体 };
  }

  for (const [名字, 帧] of 错误帧) {
    it(`「${名字}」两条通道都报错`, async () => {
      const { 对话, 智能体 } = await 两边跑(帧);

      // detail 那一帧此前在智能体这条线上被**静默吞掉** ——
      // callWithTools 正常返回一个空结果,智能体只看到「这一轮什么都没有」,
      // 而错误信息就在那一帧里。用户会以为是模型不干活。
      expect(对话, "对话通道把错误吞了").not.toBeNull();
      expect(智能体, "智能体通道把错误吞了").not.toBeNull();
    });

    it(`「${名字}」两条通道给出同一句话`, async () => {
      const { 对话, 智能体 } = await 两边跑(帧);
      // 这才是这组守卫真正要守的:同一帧,同一个结论。
      // 措辞由 translateUpstreamError 统一决定,两边不许各翻各的。
      expect(智能体, "同一帧在两条通道上被解释成了不同的话").toBe(对话);
    });
  }
});

describe("正常帧:两条通道读出同样的内容", () => {
  const 帧 =
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' +
    'data: {"choices":[{"delta":{"reasoning_content":"在想"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":22}}\n\n' +
    "data: [DONE]\n\n";

  it("正文、思考、finish_reason、用量四项都对得上", async () => {
    const a = await load();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(帧)));
    const r = await a.gateway.streamChat({
      credentials: a.credentials,
      model: "m",
      messages: [{ role: "user", content: "q" }],
      signal: new AbortController().signal,
    });
    let 正文 = "";
    let 思考 = "";
    for await (const c of r.stream) {
      if (c.kind === "content") 正文 += c.text;
      else 思考 += c.text;
    }
    vi.unstubAllGlobals();

    const b = await load();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(帧)));
    const turn = await b.gateway.callWithTools({
      credentials: b.credentials,
      model: "m",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });
    vi.unstubAllGlobals();

    expect(正文).toBe("你好");
    expect(turn.text, "两条通道读出的正文不一致").toBe(正文);
    expect(思考).toBe("在想");
    expect(turn.reasoning, "两条通道读出的思考不一致").toBe(思考);
    expect(turn.finishReason).toBe("stop");
    expect(turn.usage.inputTokens).toBe(11);
    expect(turn.usage.outputTokens).toBe(22);
    expect(r.usage.inputTokens, "两条通道读出的用量不一致").toBe(
      turn.usage.inputTokens,
    );
  });
});
