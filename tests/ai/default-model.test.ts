import { describe, expect, it } from "vitest";
import { pickDefaultModel, UNSTABLE_MODEL_IDS } from "@/lib/ai/default-model";

type ModelOption = {
  providerId: string;
  providerName: string;
  modelId: string;
  value: string;
};

const models: ModelOption[] = [
  { providerId: "p1", providerName: "NVIDIA NIM", modelId: "google/gemma-4-31b-it", value: "p1::google/gemma-4-31b-it" },
  { providerId: "p1", providerName: "NVIDIA NIM", modelId: "openai/gpt-oss-20b", value: "p1::openai/gpt-oss-20b" },
  { providerId: "p1", providerName: "NVIDIA NIM", modelId: "openai/gpt-oss-120b", value: "p1::openai/gpt-oss-120b" },
];

describe("pickDefaultModel", () => {
  it("排除已知不稳定模型(gemma-4-31b-it)后取首个健康模型", () => {
    expect(UNSTABLE_MODEL_IDS.has("google/gemma-4-31b-it")).toBe(true);
    const picked = pickDefaultModel(models);
    expect(picked).not.toContain("gemma-4-31b-it");
    expect(picked).toBe("p1::openai/gpt-oss-20b"); // 20b 是首个健康模型
  });

  it("列表为空时返回空串", () => {
    expect(pickDefaultModel([])).toBe("");
  });

  it("全部为不稳定模型时回退到 models[0]", () => {
    const first = models[0] as ModelOption; // fixture 非空,索引安全
    expect(pickDefaultModel([first])).toBe(first.value);
  });
});
