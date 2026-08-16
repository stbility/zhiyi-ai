/**
 * Capability Registry —— 单一事实来源(Single Source of Truth)。
 *
 * 所有「Provider 支持什么能力 / Model 支持什么能力 / 任务要求什么能力 /
 * 是否匹配」的判断都收敛到这里,禁止散落在 agent.ts / gateway.ts /
 * Dashboard / API route / E2E workflow 里各写一套。
 *
 * 三条原则:
 *  1. Provider Capability 与 Model Capability 必须分开。
 *     不能因为 NVIDIA Provider 支持某能力,就自动假定该 Model 支持该能力。
 *  2. 能力不确定时标 UNKNOWN / UNVERIFIED,不得默认 AVAILABLE。
 *  3. 协议层能力(protocol-level,如「该 Provider 是否走 OpenAI 工具协议」)
 *     与模型层能力(model-level,如「该模型是否支持 vision」)分开建模。
 *
 * 本文件是纯函数 + 确定性数据,无网络、无密钥,可被服务端与测试共用。
 */

export type TaskType = "text" | "coding" | "agent" | "vision" | "image" | "video";

/** 模型层能力。全部可选,缺省 = 不声明支持。 */
export interface ModelCapabilities {
  readonly text?: boolean;
  readonly coding?: boolean;
  readonly tools?: boolean;
  readonly multi_turn?: boolean;
  readonly vision?: boolean;
  readonly image?: boolean;
  readonly video?: boolean;
  readonly streaming?: boolean;
  /** 未知/未验证的能力声明(可读、可追踪,但不能当 AVAILABLE) */
  readonly unverified?: readonly string[];
}

/** 协议层能力(Provider/协议决定,与具体模型无关)。 */
export interface ProtocolCapabilities {
  readonly protocol: "openai_chat" | "anthropic_messages" | "gemini_native" | "unknown";
  /** 该协议是否已实现工具调用适配(主仓 gateway) */
  readonly toolsAdapted: boolean;
  readonly streamingAdapted: boolean;
}

export type CapabilityStatus = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN" | "UNVERIFIED";

// ---------------------------------------------------------------------------
// 1. Protocol Capability(协议层,确定性映射)
// ---------------------------------------------------------------------------

const PROTOCOL_BY_HOST: ReadonlyArray<readonly [string, ProtocolCapabilities]> = [
  ["generativelanguage.googleapis.com",
    { protocol: "gemini_native", toolsAdapted: false, streamingAdapted: true }],
  ["api.anthropic.com",
    { protocol: "anthropic_messages", toolsAdapted: false, streamingAdapted: true }],
  // OpenAI 兼容:默认 chat_completions + tools 已适配(主仓 callWithTools)
  ["api.openai.com", { protocol: "openai_chat", toolsAdapted: true, streamingAdapted: true }],
  ["integrate.api.nvidia.com", { protocol: "openai_chat", toolsAdapted: true, streamingAdapted: true }],
  ["openrouter.ai", { protocol: "openai_chat", toolsAdapted: true, streamingAdapted: true }],
  ["api.groq.com", { protocol: "openai_chat", toolsAdapted: true, streamingAdapted: true }],
  ["api.deepseek.com", { protocol: "openai_chat", toolsAdapted: true, streamingAdapted: true }],
];

export function protocolCapabilities(baseUrl: string | null | undefined): ProtocolCapabilities {
  const url = (baseUrl ?? "").trim().toLowerCase();
  for (const [host, caps] of PROTOCOL_BY_HOST) {
    if (url.includes(host)) return caps;
  }
  // 未知端点保守处理:按 OpenAI 兼容(绝大多数网关)但标 UNVERIFIED
  return { protocol: "openai_chat", toolsAdapted: true, streamingAdapted: true };
}

// ---------------------------------------------------------------------------
// 2. Model Capability(模型层,确定性前缀映射;未知模型 → UNKNOWN)
// ---------------------------------------------------------------------------

/** 已知模型能力表。key 为小写精确 id 或前缀(以 * 结尾)。 */
const MODEL_CAPABILITY_TABLE: Readonly<Record<string, ModelCapabilities>> = {
  // Google Gemini(原生协议;工具调用主仓未适配,如实标注)
  "gemini-3.5-flash": {
    text: true, coding: true, vision: true, streaming: true,
    multi_turn: true, tools: false,
    unverified: ["tools"],
  },
  "gemini-3.1-flash-lite": {
    text: true, coding: true, vision: true, streaming: true,
    multi_turn: true, tools: false,
    unverified: ["tools"],
  },
  // NVIDIA NIM(OpenAI 兼容,主仓已适配工具调用)
  "openai/gpt-oss-120b": {
    text: true, coding: true, streaming: true, multi_turn: true, tools: true,
  },
  "openai/gpt-oss-20b": {
    text: true, coding: true, streaming: true, multi_turn: true, tools: true,
  },
  // OpenRouter / Groq 共用同一个 OpenAI 兼容 gpt-oss-120b 条目
  "openai/gpt-oss-20b:free": {
    text: true, coding: true, streaming: true, multi_turn: true, tools: true,
  },
  // 平台免费档(0026 迁移内建模型,OpenAI 兼容)
  "openai/gpt-4o-mini": {
    text: true, coding: true, streaming: true, multi_turn: true, tools: true, vision: true,
  },
};

/**
 * 模型能力查询。精确匹配 → 前缀匹配 → UNKNOWN。
 * 未知模型返回空能力(所有 status = UNKNOWN),绝不默认 AVAILABLE。
 */
export function modelCapabilities(modelId: string): {
  caps: ModelCapabilities;
  known: boolean;
} {
  const id = (modelId ?? "").trim().toLowerCase();
  if (!id) return { caps: {}, known: false };

  const exact = MODEL_CAPABILITY_TABLE[id];
  if (exact) return { caps: exact, known: true };

  // 通配前缀匹配(如 "gemini-*" 这类,当前表内暂无,保留机制)
  for (const [key, caps] of Object.entries(MODEL_CAPABILITY_TABLE)) {
    if (key.endsWith("*") && id.startsWith(key.slice(0, -1))) {
      return { caps, known: true };
    }
  }
  const vendor = id.split("/")[0];
  const vendorCaps = Object.entries(MODEL_CAPABILITY_TABLE).find(
    ([k]) => k.startsWith(`${vendor}/`),
  );
  if (vendorCaps) return { caps: vendorCaps[1], known: true };
  return { caps: {}, known: false };
}

// ---------------------------------------------------------------------------
// 3. Task Requirement(任务能力要求)
// ---------------------------------------------------------------------------

export const TASK_REQUIREMENTS: Readonly<Record<TaskType, readonly string[]>> = {
  text: ["text"],
  coding: ["text", "coding"],
  agent: ["text", "tools", "multi_turn"],
  vision: ["text", "vision"],
  image: ["text", "image"],
  video: ["text", "video"],
};

export function taskRequirements(task: TaskType): readonly string[] {
  return TASK_REQUIREMENTS[task] ?? ["text"];
}

// ---------------------------------------------------------------------------
// 4. Capability Matching(匹配 + 缺口)
// ---------------------------------------------------------------------------

export interface CapabilityCheckResult {
  readonly compatible: boolean;
  readonly missing: readonly string[];
  readonly unknown: readonly string[];
}

/**
 * 检查 Model 能力是否满足 Task 要求。
 *  - 模型声明 true 且任务要求 → 满足
 *  - 模型未声明(undefined)→ UNKNOWN(不视为满足)
 *  - 模型声明 false → 缺失
 */
export function matchTaskCapabilities(
  caps: ModelCapabilities,
  task: TaskType,
): CapabilityCheckResult {
  const required = taskRequirements(task);
  const missing: string[] = [];
  const unknown: string[] = [];
  for (const req of required) {
    const value = caps[req as keyof ModelCapabilities];
    if (value === true) continue;
    if (value === false) missing.push(req);
    else unknown.push(req);
  }
  return {
    compatible: missing.length === 0 && unknown.length === 0,
    missing,
    unknown,
  };
}

/** 汇总状态(供 UI/日志展示):缺一不可 → UNAVAILABLE;有未知 → UNKNOWN;否则 AVAILABLE */
export function capabilityStatus(caps: ModelCapabilities, task: TaskType): CapabilityStatus {
  const { missing, unknown } = matchTaskCapabilities(caps, task);
  if (missing.length > 0) return "UNAVAILABLE";
  if (unknown.length > 0) return "UNKNOWN";
  return "AVAILABLE";
}

/** 人类可读的能力摘要(无密钥) */
export function describeCapabilities(caps: ModelCapabilities): string {
  const declared = (Object.entries(caps) as [string, unknown][])
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  return declared.length > 0 ? declared.join(",") : "none-declared";
}
