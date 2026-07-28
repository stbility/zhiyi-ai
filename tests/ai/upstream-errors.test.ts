import { describe, expect, it, vi } from "vitest";

/**
 * 服务商错误翻译测试。
 *
 * 真实案例:NVIDIA 返回
 *   ResourceExhausted: Worker local total request limit reached (3228/48)
 * 直接抛给用户毫无意义 —— 它的实际含义是「这个模型此刻排队爆满」,
 * 用户该做的是换模型或稍后重试。翻译必须指向可执行的下一步。
 *
 * 同时保证:未收录的错误保留原文,绝不粉饰成笼统的「操作失败」。
 */

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return import("@/lib/ai/gateway");
}

describe("服务商错误翻译", () => {
  it("容量耗尽 → 建议换模型或稍后重试", async () => {
    const { translateUpstreamError } = await load();
    const text = translateUpstreamError(
      "ResourceExhausted: Worker local total request limit reached (3228/48)",
    );
    expect(text).toContain("排队已满");
    expect(text).toContain("换一个模型");
    // 不该把 3228/48 这种内部计数丢给用户
    expect(text).not.toContain("3228");
  });

  it("限流 → 提示稍等", async () => {
    const { translateUpstreamError } = await load();
    expect(translateUpstreamError("rate limit exceeded")).toContain("限流");
    expect(translateUpstreamError("Too Many Requests")).toContain("限流");
  });

  it("上下文超长 → 建议新开对话", async () => {
    const { translateUpstreamError } = await load();
    const text = translateUpstreamError(
      "This model's maximum context length is 8192 tokens",
    );
    expect(text).toContain("上下文");
    expect(text).toContain("新开");
  });

  it("模型下线 → 指向重新测试连接", async () => {
    const { translateUpstreamError } = await load();
    const text = translateUpstreamError("The model `foo` does not exist");
    expect(text).toContain("模型服务");
  });

  it("密钥问题 → 指向检查密钥", async () => {
    const { translateUpstreamError } = await load();
    expect(translateUpstreamError("invalid api key")).toContain("密钥");
    expect(translateUpstreamError("Unauthorized")).toContain("密钥");
  });

  it("额度不足 → 指向服务商账户", async () => {
    const { translateUpstreamError } = await load();
    expect(translateUpstreamError("insufficient quota")).toContain("额度");
  });

  it("未收录的错误保留原文,不吞不粉饰", async () => {
    const { translateUpstreamError } = await load();
    const raw = "Something entirely unexpected happened upstream";
    expect(translateUpstreamError(raw)).toContain(raw);
  });

  it("空回复解释会复用同一套翻译", async () => {
    const { explainEmptyResponse } = await load();
    const text = explainEmptyResponse({
      finishReason: null,
      streamError: "ResourceExhausted: Worker local total request limit reached",
      seenDeltaKeys: [],
      chunkCount: 1,
    });
    expect(text).toContain("排队已满");
  });
});
