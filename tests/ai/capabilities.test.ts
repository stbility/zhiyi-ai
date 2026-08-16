import { describe, expect, it } from "vitest";

import {
  capabilityStatus,
  matchTaskCapabilities,
  modelCapabilities,
  protocolCapabilities,
} from "@/lib/ai/capabilities";

describe("capabilities: protocol", () => {
  it("NVIDIA → openai_chat + tools 已适配", () => {
    const p = protocolCapabilities("https://integrate.api.nvidia.com/v1");
    expect(p.protocol).toBe("openai_chat");
    expect(p.toolsAdapted).toBe(true);
  });

  it("Gemini → gemini_native + tools 未适配(主仓如实标注)", () => {
    const p = protocolCapabilities("https://generativelanguage.googleapis.com/v1beta");
    expect(p.protocol).toBe("gemini_native");
    expect(p.toolsAdapted).toBe(false);
  });

  it("未知端点 → openai_chat 保守(不默认 gemini/anthropic)", () => {
    const p = protocolCapabilities("https://my-gateway.example.com/v1");
    expect(p.protocol).toBe("openai_chat");
  });
});

describe("capabilities: model", () => {
  it("已知模型返回声明能力", () => {
    const { caps, known } = modelCapabilities("openai/gpt-oss-120b");
    expect(known).toBe(true);
    expect(caps.tools).toBe(true);
    expect(caps.text).toBe(true);
  });

  it("未知模型 known=false,能力为空(不默认 AVAILABLE)", () => {
    const { caps, known } = modelCapabilities("totally-unknown-model-x");
    expect(known).toBe(false);
    expect(caps.text).toBeUndefined();
  });

  it("Provider 能力 ≠ Model 能力(Gemini 协议无工具适配,但模型本身声明 tools=false)", () => {
    const { caps } = modelCapabilities("gemini-3.5-flash");
    expect(caps.tools).toBe(false);
    expect(caps.vision).toBe(true);
  });
});

describe("capabilities: task matching", () => {
  it("agent 任务要求 text+tools+multi_turn,NVIDIA 模型满足", () => {
    const { caps } = modelCapabilities("openai/gpt-oss-120b");
    const r = matchTaskCapabilities(caps, "agent");
    expect(r.compatible).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("agent 任务,Gemini 模型缺 tools → INCOMPATIBLE 且明确列出", () => {
    const { caps } = modelCapabilities("gemini-3.5-flash");
    const r = matchTaskCapabilities(caps, "agent");
    expect(r.compatible).toBe(false);
    expect(r.missing).toContain("tools");
  });

  it("未知模型 agent 任务 → UNKNOWN 而非 AVAILABLE", () => {
    const r = matchTaskCapabilities({}, "agent");
    expect(r.compatible).toBe(false);
    expect(r.unknown.length).toBeGreaterThan(0);
    expect(capabilityStatus({}, "agent")).toBe("UNKNOWN");
  });

  it("vision 任务需要 vision,未声明 vision 的模型 → UNKNOWN(不视为 AVAILABLE)", () => {
    const { caps } = modelCapabilities("openai/gpt-oss-120b");
    const r = matchTaskCapabilities(caps, "vision");
    expect(r.compatible).toBe(false);
    // vision 未声明(undefined)→ UNKNOWN,不是 AVAILABLE
    expect(r.missing).not.toContain("vision");
    expect(r.unknown).toContain("vision");
    expect(capabilityStatus(caps, "vision")).toBe("UNKNOWN");
  });
});
