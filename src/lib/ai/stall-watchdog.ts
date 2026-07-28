/**
 * 超时看门狗。
 *
 * 背景:Vercel Hobby 计划的函数上限是 300 秒且调不高(官方文档
 * https://vercel.com/docs/functions/configuring-functions/duration)。
 * 上游模型服务排队不回应时,如果我们不主动放弃,函数就会一路挂到被平台强杀 ——
 * 连接被掐断,浏览器只能报「Failed to fetch」,用户完全不知道发生了什么。
 * 生产环境真实记录到的三次失败耗时是 296234 / 298105 / 296548 毫秒,全部贴着上限。
 *
 * 所以要在撞上限之前主动失败,并把原因说清楚。
 *
 * 看门狗掐断和客户端自己断开都表现为 abort,必须能区分:前者要告诉用户
 * 模型没响应,后者没人在等回复,不必再做什么。`reason` 非空即代表是前者。
 */

export interface StallWatchdog {
  /** 重新计时。有进展时调用 —— 只有「卡住不动」才该被掐断 */
  arm(ms: number, reason: string): void;
  /** 停表。正常收尾时调用,避免定时器悬着 */
  clear(): void;
  /** 非空表示是看门狗掐断的,值为可直接展示给用户的原因 */
  readonly reason: string | null;
  readonly signal: AbortSignal;
}

/**
 * @param totalBudgetMs 总预算,兜住「一直有零星输出但永远不结束」的情况
 * @param totalBudgetReason 触发总预算时给用户看的说明
 * @param upstream 客户端断开等外部中止信号,会一并传导
 */
export function createStallWatchdog(
  totalBudgetMs: number,
  totalBudgetReason: string,
  upstream?: AbortSignal,
): StallWatchdog {
  const controller = new AbortController();
  let reason: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    clearTimeout(timer);
    clearTimeout(total);
  };

  const total = setTimeout(() => {
    reason = totalBudgetReason;
    stop();
    controller.abort();
  }, totalBudgetMs);

  if (upstream) {
    if (upstream.aborted) {
      stop();
      controller.abort();
    } else {
      upstream.addEventListener("abort", () => {
        // 客户端走了 —— 不设 reason,调用方据此知道无需解释什么
        stop();
        controller.abort();
      });
    }
  }

  return {
    arm(ms, r) {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        reason = r;
        stop();
        controller.abort();
      }, ms);
    },
    clear: stop,
    get reason() {
      return reason;
    },
    signal: controller.signal,
  };
}
