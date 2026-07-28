import { describe, expect, it, vi } from "vitest";

import { createStallWatchdog } from "@/lib/ai/stall-watchdog";

/**
 * 超时看门狗测试。
 *
 * 真实故障:生产环境三次失败的耗时是 296234 / 298105 / 296548 毫秒,
 * 全部贴着 Vercel 的 300 秒函数上限。网关对上游没有任何超时,服务商排队
 * 不回应就一直挂到函数被强杀 —— 连接被掐断,浏览器只能报「Failed to fetch」。
 *
 * 这些断言保证:该掐断时掐断、掐断时说得出原因、有进展时不误伤、
 * 客户端自己走掉时不冒充成模型故障。
 */

const REASON = "模型在 45 秒内没有返回任何内容,通常是该模型正在排队。";
const BUDGET = "本次调用已超过 240 秒仍未完成,已中止。";

describe("超时看门狗", () => {
  it("上游一直不出内容 → 掐断并给出原因", async () => {
    vi.useFakeTimers();
    const w = createStallWatchdog(240_000, BUDGET);
    w.arm(45_000, REASON);

    expect(w.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(w.signal.aborted).toBe(true);
    expect(w.reason).toBe(REASON);
    vi.useRealTimers();
  });

  it("有进展就重新计时 —— 正在输出的对话不该被误伤", async () => {
    vi.useFakeTimers();
    const w = createStallWatchdog(240_000, BUDGET);
    w.arm(45_000, REASON);

    // 每 40 秒来一次内容,连续 5 次:总时长 200 秒,远超单次 45 秒
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(40_000);
      expect(w.signal.aborted, `第 ${i + 1} 次推进后不应中止`).toBe(false);
      w.arm(45_000, REASON);
    }
    vi.useRealTimers();
  });

  it("总预算兜住「零星输出但永不结束」", async () => {
    vi.useFakeTimers();
    const w = createStallWatchdog(240_000, BUDGET);

    // 每 30 秒一次进展,单次永远不超时,但总时长会撞上预算
    for (let i = 0; i < 10; i++) {
      w.arm(45_000, REASON);
      await vi.advanceTimersByTimeAsync(30_000);
      if (w.signal.aborted) break;
    }

    expect(w.signal.aborted).toBe(true);
    expect(w.reason).toBe(BUDGET);
    vi.useRealTimers();
  });

  it("客户端自己断开时不设原因 —— 那不是模型的问题", () => {
    const client = new AbortController();
    const w = createStallWatchdog(240_000, BUDGET, client.signal);
    w.arm(45_000, REASON);

    client.abort();

    expect(w.signal.aborted).toBe(true);
    // reason 为空,调用方据此知道没人在等回复,不必解释什么
    expect(w.reason).toBeNull();
  });

  it("传入的信号已经中止时立刻传导", () => {
    const client = new AbortController();
    client.abort();
    const w = createStallWatchdog(240_000, BUDGET, client.signal);

    expect(w.signal.aborted).toBe(true);
    expect(w.reason).toBeNull();
  });

  it("clear 之后不再触发 —— 正常收尾不该留下悬着的定时器", async () => {
    vi.useFakeTimers();
    const w = createStallWatchdog(240_000, BUDGET);
    w.arm(45_000, REASON);
    w.clear();

    await vi.advanceTimersByTimeAsync(300_000);

    expect(w.signal.aborted).toBe(false);
    expect(w.reason).toBeNull();
    vi.useRealTimers();
  });

  it("已中止后再 arm 不会覆盖原因", async () => {
    vi.useFakeTimers();
    const w = createStallWatchdog(240_000, BUDGET);
    w.arm(45_000, REASON);
    await vi.advanceTimersByTimeAsync(45_000);

    w.arm(1_000, "另一个原因");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(w.reason).toBe(REASON);
    vi.useRealTimers();
  });
});
