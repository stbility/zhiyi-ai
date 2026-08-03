import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 对话主链路上**不得有任何人为时限** —— 这是一条反向守卫。
 *
 * 这个文件先后守过三道闸门,它们都被删了,而且是同一个理由被删的:
 *
 *   1. 吞吐下限(90 秒内不足 200 字符即中止)
 *      立论数据在生产库里查无此记录。当时引用的「284 秒 / 18 token」
 *      不存在;真实吞吐是 08-02 的 97~129 token/秒,比加闸门之前还快。
 *
 *   2. 首片超时(45 秒没有第一个分片即中止)
 *      推理模型会先思考很久才吐第一个字,而思考过程要服务商吐
 *      reasoning_content 我们才收得到 —— NVIDIA 的部署未必开着。
 *      于是一次**正在正常工作**的推理调用在第 45 秒被判成「正在排队」。
 *
 *   3. 停滞超时(中途 60 秒没有增量即中止)
 *      同上,只是发生在流中间。
 *
 * 三次都是同一个错误:**拿一个拍脑袋的阈值去判断「这次调用还有没有希望」**,
 * 而判错的代价全部由用户承担 —— 他看到的是「模型不能用了」,
 * 而模型其实好好的。
 *
 * 产品定位上也不成立:用户用自己的密钥、自己付费,
 * 我们没有立场替他决定「等多久算太久」。
 *
 * 唯一允许存在的时限是**平台强制**的那个:Vercel 的函数最长 300 秒,调不高。
 * 它保留的意义不是「早点掐断」,而是在撞上限之前主动收尾把原因说清楚 ——
 * 被平台强杀时连接直接断开,浏览器只报「Failed to fetch」。
 */

const ROUTE = readFileSync(
  resolve(__dirname, "../../src/app/api/chat/route.ts"),
  "utf8",
);

describe("不得再往对话主链路上加人为时限", () => {
  it("没有吞吐阈值", () => {
    expect(ROUTE).not.toMatch(/THROUGHPUT/);
    expect(ROUTE).not.toMatch(/producedChars/);
    // 形如 `xxxChars < 200` 的判定
    expect(ROUTE).not.toMatch(/[Cc]hars\s*<\s*\d+/);
  });

  it("没有首片超时", () => {
    expect(ROUTE).not.toMatch(/FIRST_CHUNK/);
  });

  it("没有停滞超时", () => {
    expect(ROUTE).not.toMatch(/STALL_TIMEOUT/);
  });

  it("除总预算外没有别的秒级常量 —— 新增一个就要先解释为什么", () => {
    // 抓 `const XXX_MS = 数字` 这种形状的时限常量。
    // 允许的只有总预算,因为它来自平台而不是我们的判断。
    const consts = [...ROUTE.matchAll(/const\s+([A-Z_]+_MS)\s*=/g)].map(
      (m) => m[1],
    );
    expect(consts).toEqual(["TOTAL_BUDGET_MS"]);
  });
});

describe("平台强制的那一个要留着", () => {
  it("总预算还在 —— 它把「被平台静默强杀」变成「说得清的中止」", () => {
    expect(ROUTE).toMatch(/TOTAL_BUDGET_MS\s*=\s*285_000/);
  });

  it("删除的理由留在代码里,不是只写在提交信息里", () => {
    // 下一个读这段代码的人必须能就地看到「这里为什么没有时限检查」,
    // 否则他会以为是漏了,然后好心地加回来 —— 前面已经发生过三次
    expect(ROUTE).toMatch(/人为时限/);
    expect(ROUTE).toMatch(/自己付费|没有立场/);
  });
});
