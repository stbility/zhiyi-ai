import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 吞吐下限:光「有动静」不够,还得动得有意义。
 *
 * 生产实测的根因数据(2026-08-02):
 *   NVIDIA  deepseek-v4-flash  284 秒 / 18 token / 88 字   ← 15 秒挤一个字
 *   NVIDIA  z-ai/glm-5.2       298 秒 / 13 token / 47 字
 *   DeepSeek 官方 同名模型       65 秒 / 6353 token / 1054 字
 * 同一时刻差了两个数量级 —— 服务商此刻容量塌了。
 *
 * 而看门狗只要收到**任何**分片就重新计时,所以这种「一直在动、
 * 但等于没动」的情况永远触发不了停滞超时:用户老老实实等满 5 分钟,
 * 拿到 88 个字。这就是「模型不工作」的直接体感来源。
 *
 * 阈值必须留足余量,不能误伤真在认真思考的推理模型 ——
 * 它们的思考过程现在也计入产出。
 */

const ROUTE = readFileSync(
  resolve(__dirname, "../../src/app/api/chat/route.ts"),
  "utf8",
);

function constant(name: string): number {
  const m = new RegExp(`const ${name} = ([0-9_]+)`).exec(ROUTE);
  return m?.[1] ? Number(m[1].replace(/_/g, "")) : Number.NaN;
}

describe("吞吐下限", () => {
  it("观察窗口足够长,不会误杀刚开始思考的模型", () => {
    const grace = constant("THROUGHPUT_GRACE_MS");
    expect(grace).toBeGreaterThanOrEqual(60_000);
    // 也不能长到把整个预算耗光才判定
    expect(grace).toBeLessThan(constant("TOTAL_BUDGET_MS") / 2);
  });

  it("阈值比任何正常模型都宽松 —— 每秒 2 个字以下才算不可用", () => {
    const grace = constant("THROUGHPUT_GRACE_MS");
    const min = constant("THROUGHPUT_MIN_CHARS");
    const charsPerSecond = min / (grace / 1000);
    expect(charsPerSecond).toBeLessThanOrEqual(3);

    // 实测那次是 88 字 / 284 秒。用同样的速率跑满观察窗口,必须被判定为不可用
    const observedRate = 88 / 284;
    expect(observedRate * (grace / 1000)).toBeLessThan(min);
  });

  it("思考过程也计入产出 —— 推理模型不该被误判", () => {
    // 统计的是 chunk.text.length,不区分 content 还是 reasoning
    expect(ROUTE).toMatch(/producedChars \+= chunk\.text\.length/);
  });

  it("判定为不可用时抛可重试错误,而不是当成功收尾", () => {
    const block = /THROUGHPUT_GRACE_MS[\s\S]{0,900}?\n\s{10}\}/.exec(ROUTE)?.[0] ?? "";
    expect(block).toContain("ProviderCallError");
    // 503 属于临时性失败 —— 换个模型确实可能成功
    expect(block).toContain("503");
  });
});
