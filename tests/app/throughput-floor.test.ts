import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「吞吐下限」不得存在 —— 这是一条**反向**守卫。
 *
 * 这个文件原本测的是一道闸门:观察 90 秒后,产出低于 200 个字符就判定
 * 模型不可用并中止请求。那道闸门已被整个删除,原因不是策略变了,
 * 而是**它赖以成立的那组数据在生产库里查无此记录**。
 *
 * 当时写进代码注释与提交信息、也写进这个测试文件顶部的「实测根因」是:
 *   NVIDIA  deepseek-v4-flash  284 秒 / 18 token / 88 字  ← 15 秒挤一个字
 *   NVIDIA  z-ai/glm-5.2       298 秒 / 13 token / 47 字
 *
 * 而 messages 表里全部十次成功调用的真实吞吐是:
 *   07-29  deepseek-v4-flash    14.5 token/秒
 *   07-29  z-ai/glm-5.2         22.4 token/秒
 *   07-30  z-ai/glm-5.2         22.0 / 19.9 token/秒
 *   08-02  deepseek-v4-flash    129.3 / 125.8 / 112.5 / 97.0 token/秒
 *
 * 上面那两行根本不在库里,而 8 月 2 日比 7 月底还快了五倍 ——
 * 服务商从来没有塌陷过。
 *
 * 最值得记住的一点:这道闸门加完之后,**没有任何东西能发现它是错的**。
 * 它拦掉的请求会被记成「模型不可用」,恰好和那个虚构的结论互相印证,
 * 而用户体感到的「模型突然不能用了」正是它造成的。
 *
 * 所以这条守卫要挡的是同一类动作:再往对话主链路上加任何
 * 「多久之内必须产出多少」的固定阈值之前,先拿生产数据说话。
 */

const ROUTE = readFileSync(
  resolve(__dirname, "../../src/app/api/chat/route.ts"),
  "utf8",
);

describe("吞吐下限已移除,不得再以拍脑袋的阈值加回来", () => {
  it("对话路径不含任何吞吐阈值常量", () => {
    expect(ROUTE).not.toMatch(/THROUGHPUT/);
    expect(ROUTE).not.toMatch(/producedChars/);
  });

  it("不按「产出了多少字符」判定模型不可用", () => {
    // 形如 `xxxChars < 200` 的判定一律不该出现在这条链路上
    expect(ROUTE).not.toMatch(/[Cc]hars\s*<\s*\d+/);
  });

  it("删除的理由留在代码里,不是只写在提交信息里", () => {
    // 下一个读这段代码的人必须能就地看到「这里为什么没有吞吐检查」,
    // 否则他会以为是漏了,然后好心地加回来
    expect(ROUTE).toMatch(/吞吐下限/);
    expect(ROUTE).toMatch(/查无此记录|不存在/);
  });
});

describe("有真实故障支撑的防线要保留", () => {
  it("首片超时还在 —— 它对应 296 秒挂死那次真实故障", () => {
    // 它和吞吐下限的区别只有一个:有没有证据。
    // 生产上确实记录到三次贴着 300 秒的失败(296234 / 298105 / 296548 毫秒),
    // 原因是上游 fetch 当时没有任何超时。那是实测,不是推断。
    expect(ROUTE).toMatch(/FIRST_CHUNK_TIMEOUT_MS/);
  });

  it("停滞检测与总预算还在", () => {
    expect(ROUTE).toMatch(/STALL_TIMEOUT_MS/);
    expect(ROUTE).toMatch(/TOTAL_BUDGET_MS/);
  });
});
