import { describe, expect, it } from "vitest";

import {
  isLikelyChatModel,
  whyNotChatModel,
} from "@/lib/providers/model-filter";

/**
 * 模型用途过滤 —— 这组测试来自一次真实事故,每一条都是生产库里的实际数据。
 *
 * 经过:英伟达目录 78+ 个模型被无差别导入进用户的模型选择器。原来的过滤
 * 规则只挡下嵌入/重排/安全分类等十来个,视觉、翻译、语音、代码补全、
 * 阿拉伯语模型全部放行。用户随手点一个:
 *   · 选中 allam-2-7b(阿拉伯语)→ 用中文问、用阿拉伯语答 → 报告为「乱码」
 *   · 选中 riva-translate / neva / vila → 调 /chat/completions 直接失败
 * 最后他手工删了 75 个,连 moonshotai/kimi-k2.6、openai/gpt-oss-120b
 * 这些好模型都误删了 —— 因为光看模型名根本分不出哪个能用。
 *
 * 所以这里的断言分两组:该挡的要挡住(正向),**不该误伤的一个都不能少**
 * (负向)。后者同样重要:误杀会让用户找不到本来能用的模型,
 * 而那正是上一版过滤规则被反复放宽的原因。
 */

/** 生产库 ai_model_exclusions 里用户手工删掉的,按类别抽样 */
const SHOULD_BLOCK: readonly [string, string][] = [
  // 视觉语言 —— 需要图像输入
  ["adept/fuyu-8b", "视觉"],
  ["microsoft/kosmos-2", "视觉"],
  ["nvidia/neva-22b", "视觉"],
  ["nvidia/vila", "视觉"],
  ["microsoft/phi-3-vision-128k-instruct", "视觉"],
  ["meta/llama-3.2-90b-vision-instruct", "视觉"],
  ["nvidia/nemotron-nano-12b-v2-vl", "视觉"],
  // 翻译专用
  ["nvidia/riva-translate-4b-instruct", "翻译"],
  ["nvidia/riva-translate-4b-instruct-v2", "翻译"],
  // 代码补全(FIM),不是对话
  ["bigcode/starcoder2-15b", "代码补全"],
  ["google/codegemma-7b", "代码补全"],
  ["meta/codellama-70b", "代码补全"],
  ["mistralai/codestral-22b-instruct-v0.1", "代码补全"],
  ["ibm/granite-34b-code-instruct", "代码补全"],
  // 校准/研究
  ["nvidia/ising-calibration-1.5-31b", "校准"],
  // 语音:识别与合成
  ["whisper-large-v3", "语音"],
  ["playai-tts", "语音"],
  ["playai-tts-arabic", "语音"],
  // 语种/地区专用 —— 中文提问会得到别的语言,用户看到的就是「乱码」
  ["allam-2-7b", "阿拉伯语"],
  ["aisingapore/sea-lion-7b-instruct", "东南亚语种"],
  // 原有规则覆盖的类别,不能因为重构而漏掉
  ["nvidia/nv-embedqa-e5-v5", "嵌入"],
  ["baai/bge-m3", "嵌入"],
  ["meta/llama-guard-4-12b", "安全分类"],
  ["nvidia/nemoretriever-parse", "解析"],
];

/** 现在库里真正在用的,以及用户误删过的好模型 —— 一个都不能被挡 */
const MUST_PASS: readonly string[] = [
  "deepseek-ai/deepseek-v4-flash",
  "deepseek-ai/deepseek-v4-pro",
  "z-ai/glm-5.2",
  "deepseek-chat",
  "deepseek-reasoner",
  // 用户误删过的好模型 —— 过滤规则绝不能替他做这个决定
  "moonshotai/kimi-k2.6",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "meta/llama-3.3-70b-instruct",
  "mistralai/mistral-large-2-instruct",
  "qwen/qwen3-235b-a22b",
  "gpt-4o",
  "glm-4",
  "moonshot-v1-8k",
  // 容易被规则误伤的形近名 —— 每一条都是具体的边界
  "microsoft/phi-4", // 不含 vision,不能被 vision 规则牵连
  "meta/llama-4-scout-17b-16e-instruct", // 17b,不能被「过小」规则吃掉
  "deepseek-ai/deepseek-coder-v2-instruct", // coder 不等于代码补全模型
  "embedded-reasoning-model", // embedded 是形容词,不是 embed 用途

  // 用户这次也删了它们,但过滤器**刻意不挡** —— 这是「质量判断」不是
  // 「用途判断」。垂直模型能对话,只是偏科;小模型中文差,但在本地
  // Ollama 上是合理选择。删除权在用户手里,系统不替他判断好不好用。
  "writer/palmyra-med-70b",
  "writer/palmyra-fin-70b-32k",
  "google/gemma-2b",
  "meta/llama-3.2-1b-instruct",
];

describe("该挡住的模型用途", () => {
  for (const [modelId, category] of SHOULD_BLOCK) {
    it(`${modelId}(${category})不进对话选择器`, () => {
      expect(isLikelyChatModel(modelId)).toBe(false);
      // 挡下来还必须能解释为什么,否则用户以为模型「丢了」
      expect(whyNotChatModel(modelId)).not.toBeNull();
    });
  }
});

describe("绝不能误伤的对话模型", () => {
  for (const modelId of MUST_PASS) {
    it(`${modelId} 照常可选`, () => {
      expect(isLikelyChatModel(modelId)).toBe(true);
      expect(whyNotChatModel(modelId)).toBeNull();
    });
  }
});

describe("拦截原因要能分辨两种情况", () => {
  it("协议上调不通的,说的是「没有对话端点」", () => {
    expect(whyNotChatModel("nvidia/riva-translate-4b-instruct")).toMatch(
      /用途不是对话/,
    );
  });

  it("调得通但答非所问的,说的是语种/领域/参数量", () => {
    // allam 能对话,只是会用阿拉伯语回答 —— 两种情况的修法不同,
    // 措辞必须能区分,否则用户不知道是「换个模型」还是「换个说法」
    expect(whyNotChatModel("allam-2-7b")).toMatch(/语种|领域|参数量/);
  });
});
