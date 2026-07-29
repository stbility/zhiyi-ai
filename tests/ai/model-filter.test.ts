import { describe, expect, it } from "vitest";

import {
  coreModelFamilyLabels,
  filterChatModels,
  indicatesModelUnusable,
  isCoreModel,
  isLikelyChatModel,
  isTransientFailure,
  selectCoreChatModels,
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

describe("核心模型家族筛选", () => {
  it("收录用户点名的三个家族:DeepSeek、Kimi、智谱 GLM", () => {
    expect(isCoreModel("deepseek-ai/deepseek-v4-pro")).toBe(true);
    expect(isCoreModel("moonshotai/kimi-k2.6")).toBe(true);
    // 智谱现用品牌 Z.ai,英伟达上的前缀是 z-ai/
    expect(isCoreModel("z-ai/glm-5.2")).toBe(true);
    expect(isCoreModel("z-ai/glm4.7")).toBe(true);
  });

  it("其余家族一律不收 —— 用户要的是几个核心模型,不是一百个", () => {
    for (const id of [
      "openai/gpt-oss-120b",
      "meta/llama-3.3-70b-instruct",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "google/gemma-3-12b-it",
      "mistralai/mistral-large",
      "qwen/qwen3-next-80b-a3b-instruct",
    ]) {
      expect(isCoreModel(id), id).toBe(false);
    }
  });

  it("前缀必须整段匹配,不能被相似厂商名蒙混", () => {
    // 「z-ai-labs/」不是「z-ai/」;前缀里带斜杠正是为了防这个
    expect(isCoreModel("notdeepseek-ai/foo")).toBe(false);
    expect(isCoreModel("xz-ai/glm")).toBe(false);
  });

  it("核心家族里的非对话模型仍然要剔除", () => {
    // 假如智谱哪天上了嵌入模型,不能因为它属于核心家族就放进对话列表
    expect(selectCoreChatModels(["z-ai/glm-embed-2"])).toEqual([]);
    expect(selectCoreChatModels(["deepseek-ai/deepseek-rerank"])).toEqual([]);
  });

  it("从服务商的完整返回中选出候选,不截断", () => {
    // 真实教训:曾写死 .slice(0, 100),把排在后面的 z-ai/* 整个家族砍掉,
    // 用户根本看不到智谱的模型。所以补一个远超 100 的列表守住这一点。
    const noise = Array.from({ length: 150 }, (_, i) => `vendor-${i}/model`);
    const all = [
      "deepseek-ai/deepseek-v4-pro",
      ...noise,
      "moonshotai/kimi-k2.6",
      "z-ai/glm-5.2",
    ];
    expect(selectCoreChatModels(all)).toEqual([
      "deepseek-ai/deepseek-v4-pro",
      "moonshotai/kimi-k2.6",
      "z-ai/glm-5.2",
    ]);
  });

  it("家族名可读,用于向用户说明收录范围", () => {
    const labels = coreModelFamilyLabels();
    expect(labels).toContain("DeepSeek");
    expect(labels.some((l) => l.includes("GLM"))).toBe(true);
  });
});

describe("临时故障与永久故障的区分", () => {
  /**
   * 这是整个可用性判定的分水岭,而且我在生产上判错过。
   *
   * 真实数据:deepseek-v4-flash 探测时报「排队已满」、deepseek-v4-pro 探测
   * 25 秒超时。这两个都是容量问题,模型本身好好的 —— 但当时按「失败即剔除」
   * 处理,用户从此在列表里再也看不到 DeepSeek。因为一次堵车就把路拆了。
   *
   * 判错方向的代价不对称:临时当永久会误删好模型且不可自愈;
   * 永久当临时只是多重试几次。所以拿不准时一律算临时。
   */
  it("排队、限流、超时都是临时的", () => {
    for (const [status, msg] of [
      [undefined, "该模型当前排队已满,服务商暂时无法接收新请求。请换一个模型,或稍后再试。"],
      [undefined, "探测超过 25 秒未返回,通常是该模型正在排队"],
      [undefined, "ResourceExhausted: Worker local total request limit reached (3228/48)"],
      [429, "rate limit exceeded"],
      [429, "Too Many Requests"],
      [408, "request timeout"],
      [500, "internal server error"],
      [502, "bad gateway"],
      [503, "service unavailable"],
      [504, "gateway timeout"],
    ] as const) {
      expect(isTransientFailure(status, msg), msg).toBe(true);
    }
  });

  it("模型下线、密钥错误不是临时的 —— 等多久都不会好", () => {
    for (const [status, msg] of [
      [404, "接口或模型不存在(HTTP 404),请检查接口地址与模型名称"],
      [401, "密钥被拒绝(HTTP 401)"],
      [403, "密钥被拒绝(HTTP 403)"],
      [400, "The model `foo` does not exist"],
    ] as const) {
      expect(isTransientFailure(status, msg), msg).toBe(false);
    }
  });

  it("临时故障绝不会让模型被永久剔除", () => {
    // 这一条守的正是我犯过的错:两个 DeepSeek 因排队被永久标记不可用
    expect(
      indicatesModelUnusable(
        undefined,
        "该模型当前排队已满,服务商暂时无法接收新请求。",
      ),
    ).toBe(false);
    expect(
      indicatesModelUnusable(undefined, "探测超过 25 秒未返回,通常是该模型正在排队"),
    ).toBe(false);
    // 即便状态码是 404,只要原因写明是排队,也不能剔除
    expect(indicatesModelUnusable(404, "服务暂时不可用,请稍后重试")).toBe(false);
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
