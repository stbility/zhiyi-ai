/**
 * 上下文预算分配。
 *
 * 智能体和聊天助手的区别之一,就是上下文要**可控且可解释**:
 * 每一轮到底把什么发给了模型、为什么某些东西没发、发了多少 ——
 * 这些都不能是黑箱,否则出了问题无从判断是模型不行还是上下文没给够。
 *
 * 两个必须同时满足的约束:
 *   1. 项目文件要跨轮保留 —— 否则第二句「改一下这个函数」模型就看不到代码了
 *   2. 总量要有上限 —— 否则长对话会持续变贵变慢,直到撞上模型的上下文窗口
 *
 * 分配策略:先保项目文件(智能体干活的依据),再用剩余额度装历史消息,
 * 历史从**最近**往前装 —— 最近几轮的相关性远高于开头几轮。
 * 装不下的部分如实统计出来,由调用方告知用户,不静默丢弃。
 */

/** 一个项目文件 */
export interface ContextFile {
  readonly path: string;
  readonly content: string;
}

/** 一条历史消息 */
export interface ContextMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ContextBudget {
  /** 全部内容的字符上限 */
  readonly totalChars: number;
  /** 项目文件最多占多少 —— 留出余量给历史与本轮提问 */
  readonly fileShare: number;
}

/**
 * 默认预算。
 *
 * 30 万字符约等于 8–10 万 token。这个数字的依据是「绝大多数模型都装得下」:
 * 常见的 128k 上下文模型有余量,百万上下文的模型更不成问题。
 * 不按单个模型的窗口来定 —— 用户随时会切换模型,按最小公约数走才不会
 * 出现「换个模型就报超长」。
 *
 * 文件占七成:智能体的工作对象是代码,那是主体;历史消息是线索,占三成够用。
 */
export const DEFAULT_BUDGET: ContextBudget = {
  totalChars: 300_000,
  fileShare: 0.7,
};

export interface BuiltContext {
  /** 拼好的项目文件块,没有文件时为空串 */
  readonly fileBlock: string;
  /** 实际带上的历史消息,已按时间正序 */
  readonly messages: readonly ContextMessage[];
  /** 用于如实告知用户的统计 */
  readonly stats: {
    readonly filesIncluded: number;
    readonly filesSkipped: number;
    readonly messagesIncluded: number;
    readonly messagesSkipped: number;
    readonly totalChars: number;
  };
}

/** 单个文件在提示里的呈现形式 —— 标明路径,模型才知道代码在项目里的位置 */
function renderFile(file: ContextFile): string {
  return `--- ${file.path} ---\n${file.content}`;
}

/**
 * 在预算内装配上下文。
 *
 * @param files 对话级项目文件,按路径排序传入以保证每轮顺序稳定
 * @param history 历史消息,按时间正序
 */
export function buildContext(
  files: readonly ContextFile[],
  history: readonly ContextMessage[],
  budget: ContextBudget = DEFAULT_BUDGET,
): BuiltContext {
  const fileBudget = Math.floor(budget.totalChars * budget.fileShare);

  // --- 项目文件 ---
  const included: ContextFile[] = [];
  let fileChars = 0;
  for (const f of files) {
    const rendered = renderFile(f);
    if (fileChars + rendered.length > fileBudget) continue;
    fileChars += rendered.length;
    included.push(f);
  }

  const fileBlock =
    included.length === 0
      ? ""
      : `以下是本次对话关联的项目文件(共 ${included.length} 个),后续提问都以它们为准:\n\n` +
        included.map(renderFile).join("\n\n") +
        "\n\n---\n\n";

  // --- 历史消息:从最近往前装 ---
  //
  // 正序截断(丢掉最近的)会让模型看不到刚说过的话,那比丢掉开头糟得多。
  const messageBudget = budget.totalChars - fileChars;
  const kept: ContextMessage[] = [];
  let messageChars = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i] as ContextMessage;
    // 空内容的消息不进上下文:失败调用会留下 content 为空的留痕记录,
    // 而 OpenAI 兼容接口不接受空内容消息,带进去会让之后每轮都失败。
    if (m.content.trim() === "") continue;
    if (messageChars + m.content.length > messageBudget) break;
    messageChars += m.content.length;
    kept.push(m);
  }
  kept.reverse();

  const usable = history.filter((m) => m.content.trim() !== "");

  return {
    fileBlock,
    messages: kept,
    stats: {
      filesIncluded: included.length,
      filesSkipped: files.length - included.length,
      messagesIncluded: kept.length,
      messagesSkipped: usable.length - kept.length,
      totalChars: fileChars + messageChars,
    },
  };
}

/**
 * 把裁剪情况说成一句人话。没有裁剪时返回 null —— 没事就不要打扰用户。
 */
export function describeTrimming(stats: BuiltContext["stats"]): string | null {
  const parts: string[] = [];
  if (stats.filesSkipped > 0) {
    parts.push(`${stats.filesSkipped} 个项目文件因超出上下文预算未带上`);
  }
  if (stats.messagesSkipped > 0) {
    parts.push(`较早的 ${stats.messagesSkipped} 条消息未带上`);
  }
  return parts.length === 0 ? null : `本轮${parts.join(",")}。`;
}
