import { describe, expect, it } from "vitest";

import {
  filterChatModels,
  indicatesModelUnusable,
  isLikelyChatModel,
} from "@/lib/providers/model-filter";

/**
 * 模型用途过滤测试。
 *
 * 真实故障:测试连接时把 NVIDIA /models 返回的全部 100 个模型无差别导入,
 * 其中向量嵌入、图像理解、安全分类等根本没有 /chat/completions 端点。
 * 用户在下拉框里选到它们,只会得到「HTTP 404」,完全不知道是自己选错了类型。
 *
 * 下面的模型标识全部取自该账号的真实返回,不是编造的样本。
 */

describe("非对话模型的识别", () => {
  it("排除向量嵌入模型", () => {
    for (const id of [
      "baai/bge-m3",
      "nvidia/embed-qa-4",
      "nvidia/llama-3.2-nv-embedqa-1b-v1",
      "nvidia/nv-embed-v1",
      "nvidia/nv-embedqa-e5-v5",
      "nvidia/nv-embedcode-7b-v1",
      "nvidia/nemotron-3-embed-1b",
      "nvidia/llama-nemotron-embed-1b-v2",
      "snowflake/arctic-embed-l",
    ]) {
      expect(isLikelyChatModel(id), id).toBe(false);
    }
  });

  it("排除安全分类与审核模型", () => {
    for (const id of [
      "meta/llama-guard-4-12b",
      "nvidia/llama-3.1-nemoguard-8b-content-safety",
      "nvidia/llama-3.1-nemoguard-8b-topic-control",
      "nvidia/nemotron-3.5-content-safety",
    ]) {
      expect(isLikelyChatModel(id), id).toBe(false);
    }
  });

  it("排除奖励、解析、检测与图像生成模型", () => {
    for (const id of [
      "nvidia/nemotron-4-340b-reward",
      "nvidia/nemoretriever-parse",
      "nvidia/nemotron-parse",
      "google/deplot",
      "nvidia/ai-synthetic-video-detector",
      "google/diffusiongemma-26b-a4b-it",
      "nvidia/nvclip",
    ]) {
      expect(isLikelyChatModel(id), id).toBe(false);
    }
  });

  it("保留真正能对话的模型 —— 错杀比漏放更糟", () => {
    for (const id of [
      "openai/gpt-oss-120b",
      "deepseek-ai/deepseek-v3.1",
      "meta/llama-3.3-70b-instruct",
      "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nvidia-nemotron-nano-9b-v2",
      "qwen/qwen3-next-80b-a3b-instruct",
      "writer/palmyra-med-70b",
      "moonshotai/kimi-k2-instruct",
      "nvidia/mistral-nemo-minitron-8b-8k-instruct",
    ]) {
      expect(isLikelyChatModel(id), id).toBe(true);
    }
  });

  it("不因为模型名里恰好含有子串就误杀", () => {
    // 「embedded」「reparse」这类词不该触发匹配 —— 边界必须是 - 或 /
    expect(isLikelyChatModel("acme/embedded-assistant-7b")).toBe(true);
    expect(isLikelyChatModel("acme/sparse-moe-8b")).toBe(true);
  });

  it("filterChatModels 保持原有顺序并只做剔除", () => {
    const input = [
      "openai/gpt-oss-120b",
      "baai/bge-m3",
      "meta/llama-3.3-70b-instruct",
      "meta/llama-guard-4-12b",
    ];
    expect(filterChatModels(input)).toEqual([
      "openai/gpt-oss-120b",
      "meta/llama-3.3-70b-instruct",
    ]);
  });
});

describe("运行时失败是否说明模型不可用", () => {
  it("404 说明该模型没有对话端点", () => {
    expect(indicatesModelUnusable(404, "接口或模型不存在")).toBe(true);
  });

  it("上游明说不支持时也算", () => {
    expect(
      indicatesModelUnusable(400, "The model `foo` does not exist"),
    ).toBe(true);
    expect(indicatesModelUnusable(400, "this endpoint is not supported")).toBe(
      true,
    );
  });

  it("临时性故障绝不能把模型永久标记为不可用", () => {
    // 这一条最重要:限流、排队、超时都是暂时的,标记了用户就再也选不到
    expect(indicatesModelUnusable(429, "rate limit exceeded")).toBe(false);
    expect(
      indicatesModelUnusable(
        503,
        "ResourceExhausted: Worker local total request limit reached (3228/48)",
      ),
    ).toBe(false);
    expect(indicatesModelUnusable(500, "internal server error")).toBe(false);
    expect(indicatesModelUnusable(401, "invalid api key")).toBe(false);
  });
});
