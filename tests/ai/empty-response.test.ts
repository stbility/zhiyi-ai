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
