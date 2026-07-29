/**
 * 判断一个模型是否可能用于对话。
 *
 * 背景:服务商的 /models 返回的是「该账号能访问的全部模型」,不等于
 * 「能用来对话的模型」。以 NVIDIA 为例,列表里混有向量嵌入、图像理解、
 * 视频检测、安全分类、图像生成、OCR、翻译、奖励模型等 —— 它们根本不提供
 * /chat/completions 端点,选中就是 404,用户却无从得知为什么。
 *
 * 这里做的是**启发式**过滤,依据模型标识里的用途词。它不可能穷尽所有情况,
 * 因此真正可靠的是第二道防线:运行时真实调用失败后自动标记该模型不可用
 * (见 /api/chat 的 404 处理)。启发式只负责把最明显的挡在前面,
 * 让用户第一次就少踩坑。
 *
 * 判断只看模型标识,不猜测服务商意图 —— 拿不准的一律放行,由运行时纠正。
 * 宁可放过,不可错杀:错杀会让用户找不到本来能用的模型。
 */

/** 用途明确不是对话的模型标识特征 */
const NON_CHAT_PATTERNS: readonly RegExp[] = [
  // 向量嵌入与检索
  // 词首匹配即可(embed / embedqa / embedcode / embedding 都算),
  // 但排除 embedded —— 那是形容词,不代表用途
  /(^|[-/])(nv-)?embed(?!ded)/i,
  /nemoretriever/i,
  /(^|[-/])bge([-/]|$)/i,
  /(^|[-/])rerank(er)?([-/]|$)/i,

  // 安全分类与审核 —— 输出的是分类标签,不是对话
  /guard/i,
  /content-safety/i,
  /topic-control/i,

  // 奖励模型 —— 输出评分
  /(^|[-/])reward([-/]|$)/i,

  // 文档解析与 OCR
  /(^|[-/])parse([-/]|$)/i,
  /(^|[-/])ocr([-/]|$)/i,
  /deplot/i,

  // 图像与视频生成/检测
  /diffusion/i,
  /video-detector/i,
  /(^|[-/])(nv)?clip([-/]|$)/i,
];

export function isLikelyChatModel(modelId: string): boolean {
  return !NON_CHAT_PATTERNS.some((pattern) => pattern.test(modelId));
}

/** 从服务商返回的模型列表中筛出可用于对话的部分 */
export function filterChatModels(
  modelIds: readonly string[],
): readonly string[] {
  return modelIds.filter(isLikelyChatModel);
}

/**
 * 判断一次调用失败是否说明「该模型不能用于对话」。
 *
 * 只在能确定是模型本身不支持时才返回 true —— 限流、容量不足这类
 * 临时性问题绝不能让模型被永久标记为不可用。
 */
export function indicatesModelUnusable(
  status: number | undefined,
  message: string,
): boolean {
  if (isTransientFailure(status, message)) return false;
  if (status === 404) return true;
  return /does not (exist|support)|not supported|unsupported.*(model|endpoint)|no such model/i.test(
    message,
  );
}

/**
 * 这次失败是不是「等一会儿就好」的临时故障?
 *
 * 区分临时与永久是整个可用性判定的关键。真实教训:探测时
 * deepseek-v4-flash 报「排队已满」、deepseek-v4-pro 探测超时,
 * 这两个都是容量问题,过一阵就恢复 —— 但当时的代码一失败就把模型永久标记为
 * 不可用,等于因为一次堵车就把路给拆了,用户再也选不到 DeepSeek。
 *
 * 判错方向的代价不对称:把临时当永久会误删好模型且不可自愈;
 * 把永久当临时只是多重试几次。所以拿不准时一律算临时。
 */
export function isTransientFailure(
  status: number | undefined,
  message: string,
): boolean {
  // 限流、超时、网关错误、服务不可用 —— 全是容量或链路问题
  if (status === 408 || status === 425 || status === 429) return true;
  if (status !== undefined && status >= 500) return true;

  return /资源|排队|限流|超时|稍后|重试|容量|繁忙|resource ?exhausted|rate.?limit|too many requests|timed? ?out|timeout|overload|capacity|unavailable|try again|temporarily|queue/i.test(
    message,
  );
}
