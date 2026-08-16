import { describe, expect, it, vi } from "vitest";

// failure-kind.ts 依赖 server-only(Next 服务端标记),测试环境需 mock
vi.mock("server-only", () => ({}));

import { classifyP1Failure } from "@/lib/ai/failure-classifier";
import { allowsFallback, fallbackPolicy, MAX_FALLBACK_ATTEMPTS } from "@/lib/ai/fallback-policy";
import { resolveFallbackCandidate, candidateKey } from "@/lib/ai/fallback-resolver";
import { ProviderCallError } from "@/lib/ai/gateway";

describe("failure-classifier: HTTP status 优先(证据驱动)", () => {
  it("401 → AUTH_FAILED", () => {
    expect(classifyP1Failure(new ProviderCallError("Unauthorized", 401))).toBe("AUTH_FAILED");
  });
  it("403 → AUTH_FAILED", () => {
    expect(classifyP1Failure(new ProviderCallError("Forbidden", 403))).toBe("AUTH_FAILED");
  });
  it("429 → RATE_LIMITED", () => {
    expect(classifyP1Failure(new ProviderCallError("rate limit", 429))).toBe("RATE_LIMITED");
  });
  it("408 → TIMEOUT", () => {
    expect(classifyP1Failure(new ProviderCallError("timeout", 408))).toBe("TIMEOUT");
  });
  it("404 → MODEL_UNAVAILABLE", () => {
    expect(classifyP1Failure(new ProviderCallError("model not found", 404))).toBe("MODEL_UNAVAILABLE");
  });
  it("400 → INVALID_REQUEST", () => {
    expect(classifyP1Failure(new ProviderCallError("bad request", 400))).toBe("INVALID_REQUEST");
  });
  it("503 → PROVIDER_ERROR", () => {
    expect(classifyP1Failure(new ProviderCallError("service unavailable", 503))).toBe("PROVIDER_ERROR");
  });
  it("网络 TypeError → NETWORK_ERROR(failure-kind transport)", () => {
    const e = new TypeError("fetch failed");
    (e as { cause?: Error }).cause = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(classifyP1Failure(e)).toBe("NETWORK_ERROR");
  });
  it("无法分类 → UNKNOWN(不猜)", () => {
    expect(classifyP1Failure(new Error("some weird thing"))).toBe("UNKNOWN");
  });
});

describe("fallback-policy: 集中 policy", () => {
  it("AUTH_FAILED / RATE_LIMITED / TIMEOUT / PROVIDER_ERROR / NETWORK_ERROR → fallback", () => {
    for (const cls of ["AUTH_FAILED", "RATE_LIMITED", "TIMEOUT", "PROVIDER_ERROR", "NETWORK_ERROR"] as const) {
      expect(allowsFallback(cls)).toBe(true);
    }
  });
  it("MODEL_UNAVAILABLE / CAPABILITY_MISMATCH → rematch", () => {
    expect(fallbackPolicy("MODEL_UNAVAILABLE").action).toBe("rematch");
    expect(fallbackPolicy("CAPABILITY_MISMATCH").action).toBe("rematch");
    expect(allowsFallback("MODEL_UNAVAILABLE")).toBe(true);
  });
  it("INVALID_REQUEST / UNKNOWN → 不 fallback", () => {
    expect(allowsFallback("INVALID_REQUEST")).toBe(false);
    expect(allowsFallback("UNKNOWN")).toBe(false);
  });
  it("全局上限存在且有限", () => {
    expect(MAX_FALLBACK_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(MAX_FALLBACK_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});

describe("fallback-resolver: 动态选择 + 防循环 + Capability Re-Match", () => {
  const nvidia = { providerId: "p-nvidia", modelId: "openai/gpt-oss-120b", providerName: "NVIDIA", enabled: true, attempted: false };
  const openrouter = { providerId: "p-or", modelId: "openai/gpt-oss-20b:free", providerName: "OpenRouter", enabled: true, attempted: false };
  const gemini = { providerId: "p-gem", modelId: "gemini-3.5-flash", providerName: "Gemini", enabled: true, attempted: false };
  const disabled = { providerId: "p-groq", modelId: "openai/gpt-oss-120b", providerName: "Groq", enabled: false, attempted: false };

  it("agent 任务:跳过 disabled 与已尝试,选到合法候选", () => {
    const result = resolveFallbackCandidate({
      taskType: "agent",
      requested: { providerId: "p-nvidia", modelId: "openai/gpt-oss-120b" },
      attempted: new Set([candidateKey(nvidia)]),
      failureClass: "AUTH_FAILED",
      candidates: [nvidia, disabled, openrouter],
    });
    expect(result?.providerId).toBe("p-or");
  });

  it("Gemini 在 agent 任务下被能力过滤(tools 未适配 → UNKNOWN 不算 AVAILABLE)", () => {
    const result = resolveFallbackCandidate({
      taskType: "agent",
      requested: { providerId: "p-nvidia", modelId: "openai/gpt-oss-120b" },
      attempted: new Set([candidateKey(nvidia)]),
      failureClass: "AUTH_FAILED",
      candidates: [nvidia, gemini],
    });
    expect(result).toBeNull();
  });

  it("全尝试过 → null(防循环出口)", () => {
    const result = resolveFallbackCandidate({
      taskType: "agent",
      requested: { providerId: "p-nvidia", modelId: "openai/gpt-oss-120b" },
      attempted: new Set([candidateKey(nvidia), candidateKey(openrouter)]),
      failureClass: "AUTH_FAILED",
      candidates: [nvidia, openrouter],
    });
    expect(result).toBeNull();
  });

  it("未知模型不进入 fallback(不默认 AVAILABLE)", () => {
    const unknown = { providerId: "p-x", modelId: "mystery-model-9", providerName: "X", enabled: true, attempted: false };
    const result = resolveFallbackCandidate({
      taskType: "text",
      requested: { providerId: "p-nvidia", modelId: "openai/gpt-oss-120b" },
      attempted: new Set(),
      failureClass: "AUTH_FAILED",
      candidates: [unknown],
    });
    expect(result).toBeNull();
  });
});
