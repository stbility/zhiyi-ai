import { describe, expect, it } from "vitest";

import {
  vendorOf,
} from "@/lib/ai/fallback";

/**
 * 降级链测试。
 *
 * 用户要「长期稳定执行任务」,而英伟达上的模型排队是常态 —— 生产实测
 * deepseek-v4-pro 探测 25 秒不返回、deepseek-v4-flash 报 Worker limit。
 * 稳定只能靠排队时自动换模型,换的顺序对不对直接决定换了有没有用。
 */

describe("厂商识别", () => {
  it("按第一个斜杠切分", () => {
    expect(vendorOf("deepseek-ai/deepseek-v4-pro")).toBe("deepseek-ai");
    expect(vendorOf("z-ai/glm-5.2")).toBe("z-ai");
  });

  it("没有斜杠时整串就是厂商", () => {
    expect(vendorOf("gpt-4o")).toBe("gpt-4o");
  });
});

/*
 * 「降级链」与「降级说明」两组测试已删 —— 它们测的
 * buildFallbackChain / describeFallback 已经没有任何调用方,
 * 连同函数一起删掉了。
 *
 * 留着的话就是用绿色的测试给死代码作证:下一个人看到测试全绿,
 * 会以为这两个函数还在生产里跑着。
 */
