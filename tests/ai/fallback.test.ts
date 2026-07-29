import { describe, expect, it } from "vitest";

import {
  buildFallbackChain,
  describeFallback,
  vendorOf,
} from "@/lib/ai/fallback";

/**
 * 降级链测试。
 *
 * 用户要「长期稳定执行任务」,而英伟达上的模型排队是常态 —— 生产实测
 * deepseek-v4-pro 探测 25 秒不返回、deepseek-v4-flash 报 Worker limit。
 * 稳定只能靠排队时自动换模型,换的顺序对不对直接决定换了有没有用。
 */

const AVAILABLE = [
  "deepseek-ai/deepseek-v4-pro",
  "deepseek-ai/deepseek-v4-flash",
  "moonshotai/kimi-k2.6",
  "z-ai/glm-5.2",
];

describe("厂商识别", () => {
  it("按第一个斜杠切分", () => {
    expect(vendorOf("deepseek-ai/deepseek-v4-pro")).toBe("deepseek-ai");
    expect(vendorOf("z-ai/glm-5.2")).toBe("z-ai");
  });

  it("没有斜杠时整串就是厂商", () => {
    expect(vendorOf("gpt-4o")).toBe("gpt-4o");
  });
});

describe("降级链", () => {
  it("首选永远排第一", () => {
    const chain = buildFallbackChain(AVAILABLE, "z-ai/glm-5.2");
    expect(chain[0]).toBe("z-ai/glm-5.2");
  });

  it("优先跨厂商 —— 同厂商共用算力池,堵一起堵", () => {
    const chain = buildFallbackChain(AVAILABLE, "deepseek-ai/deepseek-v4-pro");
    // 第二个必须不是 deepseek,否则换了等于没换
    expect(vendorOf(chain[1]!)).not.toBe("deepseek-ai");
    // 同厂商的另一个模型排在所有异厂商之后
    expect(chain.indexOf("deepseek-ai/deepseek-v4-flash")).toBe(
      chain.length - 1,
    );
  });

  it("覆盖全部可用模型,不重不漏", () => {
    const chain = buildFallbackChain(AVAILABLE, "moonshotai/kimi-k2.6");
    expect([...chain].sort()).toEqual([...AVAILABLE].sort());
    expect(new Set(chain).size).toBe(chain.length);
  });

  it("首选不在可用列表里也照样排第一 —— 用户的选择优先于我们的判断", () => {
    const chain = buildFallbackChain(AVAILABLE, "some/newly-added");
    expect(chain[0]).toBe("some/newly-added");
    expect(chain).toHaveLength(AVAILABLE.length + 1);
  });

  it("只有一个模型时链就是它自己,不会退化成空链", () => {
    expect(buildFallbackChain(["z-ai/glm-5.2"], "z-ai/glm-5.2")).toEqual([
      "z-ai/glm-5.2",
    ]);
  });

  it("可用列表为空时仍返回首选 —— 至少要试一次,而不是直接放弃", () => {
    expect(buildFallbackChain([], "z-ai/glm-5.2")).toEqual(["z-ai/glm-5.2"]);
  });
});

describe("降级说明", () => {
  it("必须同时点明原选、实际使用和原因", () => {
    const text = describeFallback(
      "deepseek-ai/deepseek-v4-pro",
      "z-ai/glm-5.2",
      "排队已满",
    );
    // 悄悄换模型等于拿另一个模型的输出冒充用户选的那个
    expect(text).toContain("deepseek-ai/deepseek-v4-pro");
    expect(text).toContain("z-ai/glm-5.2");
    expect(text).toContain("排队已满");
  });
});
