/**
 * 模型降级链。
 *
 * 用户要的是「长期稳定执行任务」。而现实是:英伟达上的模型会排队 ——
 * 生产环境实测,deepseek-v4-pro 探测 25 秒不返回、deepseek-v4-flash 直接报
 * 「Worker local total request limit reached」。这不是故障,是共享算力的常态。
 *
 * 所以稳定不能靠「挑一个永远不排队的模型」(不存在),只能靠**排队时自动换一个**。
 * 这就是降级链:主模型排不上队,立刻换下一个,任务不中断。
 *
 * 关键设计:同厂商的模型往往共用一个算力池,DeepSeek 堵的时候通常整家都堵。
 * 所以降级要**优先跨厂商**,而不是在同一家里打转 —— 否则换了等于没换。
 */

/** 从模型标识里取厂商前缀,如 deepseek-ai/deepseek-v4-pro → deepseek-ai */
export function vendorOf(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash === -1 ? modelId : modelId.slice(0, slash);
}

/**
 * 排出调用顺序:首选模型在前,其后按「先换厂商、再换同厂商」排列。
 *
 * @param available 当前可选的全部模型(已通过可用性判定)
 * @param preferred 用户选中的模型
 */
export function buildFallbackChain(
  available: readonly string[],
  preferred: string,
): readonly string[] {
  const chain = [preferred];
  const seen = new Set([preferred]);
  const preferredVendor = vendorOf(preferred);

  // 第一梯队:不同厂商 —— 同厂商多半共用算力池,堵一起堵
  for (const m of available) {
    if (!seen.has(m) && vendorOf(m) !== preferredVendor) {
      chain.push(m);
      seen.add(m);
    }
  }

  // 第二梯队:同厂商的其它模型,聊胜于无
  for (const m of available) {
    if (!seen.has(m)) {
      chain.push(m);
      seen.add(m);
    }
  }

  return chain;
}

/**
 * 降级发生后给用户看的说明。
 *
 * 必须说,不能悄悄换。用户选了 DeepSeek 却收到 GLM 的回答,却不知道换过 ——
 * 那是拿另一个模型的输出冒充他选的模型,和伪造结果没有区别。
 */
export function describeFallback(
  requested: string,
  actual: string,
  reason: string,
): string {
  return `「${requested}」当前不可用(${reason}),已自动改用「${actual}」完成本次回复。`;
}
