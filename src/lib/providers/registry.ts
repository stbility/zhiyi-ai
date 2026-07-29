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

/**
 * 服务商 Base URL 预设。
 *
 * 目标是「几乎所有服务商都能配」,不设地区限制 —— 国内外、云端本地一视同仁。
 * 预设只是省去查文档的步骤,**不是白名单**:任何 OpenAI 兼容的地址都能手填,
 * 包括自建的 vLLM、公司内网网关、这里没列出的新服务商。
 *
 * 每条都带官方文档链接,方便核对地址是否变更、以及去哪里申请密钥。
 * 这里只收录能确认的官方地址;拿不准的宁可不列,也不写一个猜的地址进来 ——
 * 填错地址的表现是「连不上」,用户会以为是自己密钥错了,极难排查。
 */
export const COMPATIBLE_PRESETS: readonly {
  label: string;
  baseUrl: string;
  /** 官方 API 文档,用于核对地址与申请密钥 */
  docsUrl: string;
  /** 分组,便于在界面里归类 */
  group: "国际" | "国内" | "聚合" | "本地";
}[] = [
  // —— 国际 ——
  {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    docsUrl: "https://platform.openai.com/docs/api-reference",
    group: "国际",
  },
  {
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    docsUrl: "https://docs.api.nvidia.com/nim/reference/llm-apis",
    group: "国际",
  },
  {
    label: "xAI Grok",
    baseUrl: "https://api.x.ai/v1",
    docsUrl: "https://docs.x.ai/docs/api-reference",
    group: "国际",
  },
  {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    docsUrl: "https://console.groq.com/docs/openai",
    group: "国际",
  },
  {
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    docsUrl: "https://docs.mistral.ai/api/",
    group: "国际",
  },
  {
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    docsUrl: "https://inference-docs.cerebras.ai/api-reference/chat-completions",
    group: "国际",
  },
  {
    label: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    docsUrl: "https://docs.perplexity.ai/api-reference/chat-completions",
    group: "国际",
  },

  // —— 聚合平台:一个密钥调多家模型 ——
  {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    docsUrl: "https://openrouter.ai/docs/api-reference/overview",
    group: "聚合",
  },
  {
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    docsUrl: "https://docs.together.ai/reference/chat-completions-1",
    group: "聚合",
  },
  {
    label: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    docsUrl: "https://docs.fireworks.ai/api-reference/post-chatcompletions",
    group: "聚合",
  },
  {
    label: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    docsUrl: "https://deepinfra.com/docs/openai_api",
    group: "聚合",
  },
  {
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    docsUrl: "https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions",
    group: "聚合",
  },

  // —— 国内 ——
  {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    docsUrl: "https://api-docs.deepseek.com/zh-cn/",
    group: "国内",
  },
  {
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
    group: "国内",
  },
  {
    label: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    docsUrl: "https://platform.moonshot.cn/docs/api/chat",
    group: "国内",
  },
  {
    label: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    docsUrl:
      "https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope",
    group: "国内",
  },
  {
    label: "火山方舟 豆包",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    docsUrl: "https://www.volcengine.com/docs/82379/1330626",
    group: "国内",
  },
  {
    label: "阶跃星辰",
    baseUrl: "https://api.stepfun.com/v1",
    docsUrl: "https://platform.stepfun.com/docs/api-reference/chat",
    group: "国内",
  },

  // —— 本地自建:无需密钥,数据不出内网 ——
  {
    label: "Ollama(本机)",
    baseUrl: "http://localhost:11434/v1",
    docsUrl: "https://docs.ollama.com/openai",
    group: "本地",
  },
  {
    label: "LM Studio(本机)",
    baseUrl: "http://localhost:1234/v1",
    docsUrl: "https://lmstudio.ai/docs/app/api/endpoints/openai",
    group: "本地",
  },
  {
    label: "vLLM(自建)",
    baseUrl: "http://localhost:8000/v1",
    docsUrl:
      "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html",
    group: "本地",
  },
];
