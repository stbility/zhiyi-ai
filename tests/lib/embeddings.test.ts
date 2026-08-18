import { describe, expect, it, vi } from "vitest";

import { embedTexts, getEmbeddingsConfig, DEFAULT_EMBEDDINGS_MODEL } from "@/lib/ai/embeddings";

describe("embedding 服务装配", () => {
  it("未配置时返回 null(降级信号)", async () => {
    const previous = { ...process.env };
    delete process.env["EMBEDDINGS_API_URL"];
    delete process.env["EMBEDDINGS_API_KEY"];
    expect(await embedTexts(["x"])).toBeNull();
    process.env = previous;
  });

  it("服务失败时返回 null 而非抛错(增强不阻断主流程)", async () => {
    const previous = { ...process.env };
    process.env["EMBEDDINGS_API_URL"] = "https://emb.invalid/embeddings";
    process.env["EMBEDDINGS_API_KEY"] = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    expect(await embedTexts(["x"])).toBeNull();
    vi.unstubAllGlobals();
    process.env = previous;
  });

  it("默认模型为 nvidia/nemotron-3-embed-1b(Nemotron 2048 基线)", () => {
    const previous = { ...process.env };
    process.env["EMBEDDINGS_API_URL"] = "https://emb.invalid/embeddings";
    process.env["EMBEDDINGS_API_KEY"] = "test-key";
    delete process.env["EMBEDDINGS_MODEL"];
    expect(DEFAULT_EMBEDDINGS_MODEL).toBe("nvidia/nemotron-3-embed-1b");
    expect(getEmbeddingsConfig()?.model).toBe("nvidia/nemotron-3-embed-1b");
    process.env = previous;
  });

  it("embedText 走 input_type=passage,embedQuery 走 input_type=query", async () => {
    const previous = { ...process.env };
    process.env["EMBEDDINGS_API_URL"] = "https://emb.invalid/embeddings";
    process.env["EMBEDDINGS_API_KEY"] = "test-key";
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push(body.input_type);
        return {
          ok: true,
          json: async () => ({ data: [{ embedding: new Array(2048).fill(0.1) }] }),
        };
      }),
    );
    const { embedText, embedQuery } = await import("@/lib/ai/embeddings");
    const p = await embedText("记忆内容");
    const q = await embedQuery("查询内容");
    expect(p).toHaveLength(2048);
    expect(q).toHaveLength(2048);
    expect(calls).toEqual(["passage", "query"]);
    vi.unstubAllGlobals();
    process.env = previous;
  });
});
