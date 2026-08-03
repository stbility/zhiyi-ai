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

  // —— 以下七类是生产事故补上的 ——
  //
  // 真实经过:英伟达目录有 78+ 个模型,上面这些规则只挡下十来个,
  // 其余全量导入进用户的模型选择器。用户随手点一个,可能是视觉模型
  // (调 /chat/completions 直接失败)、翻译模型(只会翻译)、
  // 阿拉伯语模型(用中文问、用阿拉伯语答 —— 用户报告为「乱码」)。
  // 最后他手工删了 75 个,连 kimi-k2.6、gpt-oss-120b 这些好模型
  // 都误删了 —— 因为光看模型名根本分不出哪个能用。
  //
  // 这些模型不是「坏」,是**用途不对**。把它们放进对话选择器,
  // 就是拿「服务商目录里有」冒充「用户能用」,和本项目一直反对的
  // 「未接通却标记为已就绪」是同一件事。

  // 语音:识别与合成,没有 /chat/completions 端点
  /whisper/i,
  /(^|[-/])(tts|asr|stt)([-/]|$)/i,
  /speech/i,
  /(^|[-/])riva([-/]|$)/i,

  // 视觉语言:需要图像输入,纯文本对话调用会失败或答非所问
  /(^|[-/])vision([-/]|$)/i,
  /(^|[-/])vl([-/]|$)/i,
  /(^|[-/])fuyu([-/]|$)/i,
  /kosmos/i,
  /(^|[-/])neva([-/]|$)/i,
  /(^|[-/])vila([-/]|$)/i,

  // 翻译专用 —— 只做翻译,不是通用助手
  /translate/i,

  // 代码补全(FIM):按前后文补全代码片段,不是对话模型
  /starcoder/i,
  /codegemma/i,
  /codellama/i,
  /codestral/i,
  /(^|[-/])[\w.]*code-instruct([-/]|$)/i,

  // 校准/研究用途,不面向终端用户
  /calibration/i,
];

/**
 * 中文工作流里事实上不可用的模型。
 *
 * 与上面不同:这些**能**对话,只是对中文用户没有意义 ——
 * 语种专用模型会用它自己的语言回答(生产上 allam-2-7b 用阿拉伯语
 * 回答中文提问,用户判断为「乱码」),极小模型的中文能力接近于零。
 *
 * 单独成一组是因为判定依据不同:上面那组是「协议上调不通」,
 * 这组是「调得通但答非所问」。将来若要支持多语种界面,该放开的是这一组。
 */
const NOT_FOR_CHINESE_PATTERNS: readonly RegExp[] = [
  // 只收语种/地区专用模型 —— 它们会用**自己的语言**回答中文提问,
  // 这正是用户报告的「乱码」:allam-2-7b 用阿拉伯语回了中文问题。
  /(^|[-/])allam([-/]|$)/i, // 阿拉伯语
  /sea-lion/i, // 东南亚语种
  /(^|[-/])jais([-/]|$)/i, // 阿拉伯语
];

// 刻意**不**收的两类,尽管用户这次把它们也删了:
//
//   垂直领域(palmyra-med / palmyra-fin)—— 它们是能对话的,只是偏科。
//   参数量小的模型(1B~3B)—— 中文差,但在本地 Ollama 上是合理选择。
//
// 这两类是「质量判断」,不是「用途判断」。本文件的既定原则是
// 「宁可放过,不可错杀 —— 错杀会让用户找不到本来能用的模型」,
// 而删除权本来就在用户手里(ai_model_exclusions)。系统只负责
// 把结构上用不了的挡住,不替用户判断好不好用。

export function isLikelyChatModel(modelId: string): boolean {
  return (
    !NON_CHAT_PATTERNS.some((pattern) => pattern.test(modelId)) &&
    !NOT_FOR_CHINESE_PATTERNS.some((pattern) => pattern.test(modelId))
  );
}

/**
 * 为什么被挡下 —— 界面要能解释,否则用户以为模型「丢了」。
 *
 * 返回 null 表示这个模型可以进选择器。
 */
export function whyNotChatModel(modelId: string): string | null {
  if (NON_CHAT_PATTERNS.some((p) => p.test(modelId))) {
    return "该模型的用途不是对话(嵌入/语音/视觉/翻译/代码补全/安全分类等),没有对话端点。";
  }
  if (NOT_FOR_CHINESE_PATTERNS.some((p) => p.test(modelId))) {
    return "该模型是特定语种专用模型,会用它自己的语言回答中文提问。";
  }
  return null;
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
