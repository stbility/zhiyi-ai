import { describe, expect, it, vi } from "vitest";

import { embedTexts } from "@/lib/ai/embeddings";

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
});
