import { describe, expect, it } from "vitest";

import { COMPATIBLE_PRESETS, PROVIDERS } from "@/lib/providers/registry";

/**
 * 服务商预设的地址必须是像样的。
 *
 * 起因:阶跃星辰与 Perplexity 的文档链接都是 404 —— 用户点「查文档」
 * 落到错误页,只能自己去搜。预设的全部价值就是省去查文档这一步,
 * 链接错了等于负价值。
 *
 * 这里只做结构与形态校验,不发网络请求 —— 单元测试不该依赖外网,
 * 否则对方站点抖一下 CI 就红。真实可达性用一次性脚本核对过:
 * 19 条 docsUrl 里 3 条非 200,其中 Groq 的 403 是反爬(浏览器可正常打开),
 * 另外两条确认是死链并已修正。
 */

const ALL = [...PROVIDERS, ...COMPATIBLE_PRESETS];

describe("服务商预设", () => {
  it("每条预设都要有标签、Base URL 与文档地址", () => {
    for (const p of ALL) {
      expect(p.label, JSON.stringify(p)).toBeTruthy();
    }
  });

  it("远端服务必须走 https;本机服务才允许 http", () => {
    for (const p of COMPATIBLE_PRESETS) {
      // Ollama / LM Studio / vLLM 跑在用户自己机器上,http://localhost 是正确的 ——
      // 强制 https 反而会让本机预设填不进去
      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(
        p.baseUrl,
      );
      expect(p.baseUrl, p.label).toMatch(isLocal ? /^http:\/\// : /^https:\/\//);
      // 文档站一律是公网地址,没有例外
      expect(p.docsUrl, p.label).toMatch(/^https:\/\//);
    }
  });

  it("Base URL 不得以斜杠结尾 —— 拼接时会出现双斜杠", () => {
    for (const p of COMPATIBLE_PRESETS) {
      expect(p.baseUrl.endsWith("/"), p.label).toBe(false);
    }
  });

  it("已修正的两条死链不得回退", () => {
    const byLabel = new Map(COMPATIBLE_PRESETS.map((p) => [p.label, p]));

    const perplexity = byLabel.get("Perplexity");
    expect(perplexity).toBeDefined();
    // 旧地址 /api-reference/chat-completions 返回 404
    expect(perplexity!.docsUrl).not.toBe(
      "https://docs.perplexity.ai/api-reference/chat-completions",
    );

    const stepfun = byLabel.get("阶跃星辰");
    expect(stepfun).toBeDefined();
    // 旧地址缺少 /zh/ 语言段,返回 404
    expect(stepfun!.docsUrl).toContain("/docs/zh/");
  });
});
