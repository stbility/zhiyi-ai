import { describe, expect, it, vi } from "vitest";

/**
 * 联网检索适配器测试。
 *
 * 模型本身没有联网能力 —— 各家平台自带的「搜索」是平台功能,通过
 * OpenAI 兼容接口调用时拿不到。所以联网必须由我们完成:
 * 检索 → 把结果连同**来源**交给模型 → 模型据实作答。
 *
 * 「带来源」是这里最要紧的一条:不带来源的联网回答和编造无异,
 * 那正是这个功能要解决的问题。
 */

const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  process.env["ENCRYPTION_KEY"] = ENCRYPTION_KEY;
  const { encryptSecret } = await import("@/lib/crypto/secret-box");
  const mod = await import("@/lib/integrations/tavily");
  return { mod, cipher: encryptSecret("tvly-test-key") };
}

describe("Tavily 检索", () => {
  it("成功时返回结构化结果", async () => {
    const { mod, cipher } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              { title: "标题一", url: "https://a.example/1", content: "摘要一" },
              { title: "标题二", url: "https://b.example/2", content: "摘要二" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const r = await mod.tavilySearch({ credentialCipher: cipher, query: "测试" });
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(2);
    expect(r.results[0]?.url).toBe("https://a.example/1");
    vi.unstubAllGlobals();
  });

  it("没有 url 的条目丢弃 —— 无法核实的来源不如不给", async () => {
    const { mod, cipher } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [{ title: "无来源", content: "x" }, { url: "https://ok" }],
          }),
          { status: 200 },
        ),
      ),
    );

    const r = await mod.tavilySearch({ credentialCipher: cipher, query: "x" });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.url).toBe("https://ok");
    vi.unstubAllGlobals();
  });

  it("密钥被拒时指向集成页,并带上服务商原话", async () => {
    const { mod, cipher } = await load();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("invalid api key", { status: 401 })),
    );

    const r = await mod.tavilySearch({ credentialCipher: cipher, query: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("集成");
    // 只说「搜索失败」等于把唯一线索丢掉 —— 这个教训在模型调用那边吃过一次
    expect(r.error).toContain("invalid api key");
    vi.unstubAllGlobals();
  });

  it("失败时不抛错,让对话能继续", async () => {
    const { mod, cipher } = await load();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const r = await mod.tavilySearch({ credentialCipher: cipher, query: "x" });
    expect(r.ok).toBe(false);
    expect(r.results).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("交给模型的材料必须带来源链接与引用要求", async () => {
    const { mod } = await load();
    const text = mod.renderSearchContext("最新消息", [
      { title: "标题", url: "https://example.com/x", content: "正文" },
    ]);

    expect(text).toContain("https://example.com/x");
    expect(text).toContain("标注来源");
    // 也要求模型区分「检索到的」与「自己知道的」,否则又变成编造
    expect(text).toContain("既有知识");
  });

  it("没有结果时不产生空的材料块", async () => {
    const { mod } = await load();
    expect(mod.renderSearchContext("x", [])).toBe("");
  });
});
