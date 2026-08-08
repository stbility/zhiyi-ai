import { describe, expect, it } from "vitest";

import { EVAL_CASES, checkEvalCase, type EvalCase } from "@/lib/eval/cases";

describe("评测集", () => {
  it("恰好 20 条用例", () => {
    expect(EVAL_CASES.length).toBe(20);
  });

  it("用例 key 唯一", () => {
    const keys = EVAL_CASES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("每条用例至少有一种判定标准", () => {
    for (const c of EVAL_CASES) {
      expect(
        (c.mustContain?.length ?? 0) + (c.mustContainAny?.length ?? 0) + (c.mustNotContain?.length ?? 0),
        `${c.key} 缺少判定标准`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("检查器确定性", () => {
  const make = (partial: Partial<EvalCase>): EvalCase => ({
    key: "t",
    name: "t",
    prompt: "p",
    timeoutMs: 1000,
    ...partial,
  });

  it("mustContain 全部命中才过", () => {
    const c = make({ mustContain: ["甲", "乙"] });
    expect(checkEvalCase(c, "甲乙丙")).toEqual({ status: "passed", reason: expect.any(String) });
    expect(checkEvalCase(c, "甲丙").status).toBe("failed");
  });

  it("mustContainAny 任一命中即过", () => {
    const c = make({ mustContainAny: ["甲", "乙"] });
    expect(checkEvalCase(c, "丙乙").status).toBe("passed");
    expect(checkEvalCase(c, "丙丁").status).toBe("failed");
  });

  it("mustNotContain 出现即挂", () => {
    const c = make({ mustNotContain: ["sk-"] });
    expect(checkEvalCase(c, "密钥是 sk-abc").status).toBe("failed");
    expect(checkEvalCase(c, "没有密钥").status).toBe("passed");
  });

  it("同一输入永远同一结论(可复现)", () => {
    const c = make({ mustContain: ["甲"], mustNotContain: ["乙"] });
    const first = checkEvalCase(c, "甲乙");
    const second = checkEvalCase(c, "甲乙");
    expect(second).toEqual(first);
  });
});
