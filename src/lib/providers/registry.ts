/**
 * Provider 注册表。
 *
 * 每一项都如实标注当前的接入状态,不把「写了名字」当成「已支持」:
 *   verified  —— Adapter 已实现,且已用真实密钥完成过连接测试
 *   untested  —— Adapter 已实现,但尚未用真实凭据验证过
 *
 * OpenAI 兼容接口是重点:DeepSeek、通义千问、智谱、Moonshot、Ollama、vLLM、
 * LocalAI、llama.cpp、企业私有网关都走这一条,只要能提供 Base URL 即可接入。
 */

export type ProviderKind =
  | "openai"
  | "anthropic"
  | "google"
  | "openai_compatible";

export type IntegrationStatus = "verified" | "untested";

export interface ProviderSpec {
  readonly kind: ProviderKind;
  readonly label: string;
  readonly description: string;
  /** 是否必须由用户填写 Base URL */
  readonly requiresBaseUrl: boolean;
  /** 未填写时使用的官方地址 */
  readonly defaultBaseUrl: string | undefined;
  /** 用于连接测试的相对路径 */
  readonly testPath: string;
  readonly status: IntegrationStatus;
  /** 该 Provider 常见的密钥前缀,用于填写提示;不做强校验 */
  readonly keyHint: string;
}

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    kind: "openai_compatible",
    label: "OpenAI 兼容接口",
    description:
      "适用于 DeepSeek、通义千问、智谱、Moonshot、Ollama、vLLM、LocalAI、llama.cpp 以及企业私有网关。填入对方提供的 Base URL 即可。",
    requiresBaseUrl: true,
    defaultBaseUrl: undefined,
    testPath: "/models",
    status: "untested",
    keyHint: "对方控制台提供的 API Key",
  },
  {
    kind: "openai",
    label: "OpenAI",
    description: "使用 OpenAI 官方接口。",
    requiresBaseUrl: false,
    defaultBaseUrl: "https://api.openai.com/v1",
    testPath: "/models",
    status: "untested",
    keyHint: "通常以 sk- 开头",
  },
  {
    kind: "anthropic",
    label: "Anthropic",
    description: "使用 Anthropic 官方接口。",
    requiresBaseUrl: false,
    defaultBaseUrl: "https://api.anthropic.com/v1",
    testPath: "/models",
    status: "untested",
    keyHint: "通常以 sk-ant- 开头",
  },
  {
    kind: "google",
    label: "Google Gemini",
    description: "使用 Google Generative Language 接口。",
    requiresBaseUrl: false,
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    testPath: "/models",
    status: "untested",
    keyHint: "Google AI Studio 生成的 API Key",
  },
];

export function getProviderSpec(kind: ProviderKind): ProviderSpec {
  const spec = PROVIDERS.find((p) => p.kind === kind);
  if (!spec) throw new Error(`未知的 Provider 类型:${kind}`);
  return spec;
}

/** 常见服务的 Base URL 预设,减少用户查文档的成本 */
export const COMPATIBLE_PRESETS: readonly {
  label: string;
  baseUrl: string;
}[] = [
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1" },
  { label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { label: "Moonshot", baseUrl: "https://api.moonshot.cn/v1" },
  { label: "Ollama(本机)", baseUrl: "http://localhost:11434/v1" },
];
