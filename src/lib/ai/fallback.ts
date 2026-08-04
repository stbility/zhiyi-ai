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

/*
 * buildFallbackChain / describeFallback 已删。
 *
 * 它们是「同一个服务商内部换模型」那一版降级的产物。后来降级改成
 * 跨服务商(lib/ai/candidates.ts),这两个函数就没有调用方了 ——
 * 而测试还在测它们,于是它们看起来一直是活的。
 * 被测试养着的死代码比普通死代码更麻烦:它有绿色的证明,
 * 谁也不敢删。
 *
 * 这个文件现在只剩 vendorOf,由 candidates.ts 用来判断
 * 「这两个模型是不是同一家」。
 */
