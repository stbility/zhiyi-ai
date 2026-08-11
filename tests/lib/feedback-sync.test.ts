import { describe, expect, it } from "vitest";

import { extractCorrectionPhrases } from "@/lib/eval/feedback-sync";

describe("反馈改写 → 判定标准提取", () => {
  it("提取改写里新增的信息段(原文没有的)", () => {
    const original = "这个方案成本较高,建议调整。";
    const edited = "这个方案成本较高,建议调整为按季度分批采购,同时考虑华东地区的物流。";
    const phrases = extractCorrectionPhrases(original, edited);
    expect(phrases.length).toBeGreaterThan(0);
    // 新信息段必须来自改写
    for (const p of phrases) {
      expect(original).not.toContain(p);
      expect(edited).toContain(p);
    }
  });

  it("纯风格改动不产生判定标准(没有新增信息)", () => {
    // 只改标点/语序,所有 ≥6 字段都仍出现在原文里 → 无判定标准
    const original = "我们同意这个方案并且支持执行。";
    const edited = "我们同意这个方案,并且支持执行!";
    const phrases = extractCorrectionPhrases(original, edited);
    expect(phrases.length).toBe(0);
  });

  it("至多 3 条判定标准", () => {
    const original = "短。";
    const edited = "第一段信息甲,第二段信息乙,第三段信息丙,第四段信息丁,第五段信息戊。";
    const phrases = extractCorrectionPhrases(original, edited);
    expect(phrases.length).toBeLessThanOrEqual(3);
  });

  it("确定性:同一输入永远同一输出", () => {
    const original = "旧文本内容。";
    const edited = "旧文本内容,但新增了重要信息甲与乙。";
    expect(extractCorrectionPhrases(original, edited)).toEqual(
      extractCorrectionPhrases(original, edited),
    );
  });
});
