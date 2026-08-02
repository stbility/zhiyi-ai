/**
 * 工作区产物的预览能力判定 —— 按文件类别决定怎么呈现。
 *
 * 「产出了文件」和「看到了效果」是两回事。用户要的是后者 ——
 * 一堆代码摆在那里,和贴在对话气泡里没有本质区别。
 *
 * 各类别的处理:
 *   - 单文件 HTML:直接渲染
 *   - 多文件前端工程(index.html + src/*.jsx):在 iframe 里现场编译后渲染
 *     (见 bundle.ts)。这类工程原本要 npm install + 构建才能跑
 *   - Markdown:渲染成排版后的文档,而不是给一坨源码
 *   - SVG:本身就是图形,直接画出来
 *   - 源码文件(.jsx/.css/...):没有独立效果,但要指出去哪儿看整体效果
 *
 * 边界必须说清楚,不能让用户以为点开就一定看得见 —— 给一个空白页
 * 比明说「这个看不了、原因是什么」糟糕得多。
 */

export type PreviewKind = "html" | "project" | "markdown" | "svg" | "none";

export interface PreviewDecision {
  readonly kind: PreviewKind;
  /** 不能预览时的原因,直接展示给用户 */
  readonly reason: string | null;
}

/** 需要构建工具才能运行的源码类型 —— 直接丢进浏览器只会是空白 */
const NEEDS_BUILD = /\.(jsx|tsx|ts|vue|svelte|astro)$/i;

/** 能作为「整体效果」入口的文件 */
function htmlEntries(allPaths: readonly string[]): readonly string[] {
  return allPaths.filter((p) => /\.html?$/i.test(p));
}

/**
 * 页面初次打开时该选中哪个文件。
 *
 * 原本取列表第一个,按字母序往往是 README.md —— 用户看到的第一眼
 * 是文档而不是成品。应当优先落在能看到效果的入口上。
 */
export function pickDefaultFile(allPaths: readonly string[]): string | null {
  if (allPaths.length === 0) return null;
  const html = htmlEntries(allPaths);
  return (
    html.find((p) => /(^|\/)index\.html?$/i.test(p)) ??
    html[0] ??
    allPaths.find((p) => /readme\.md$/i.test(p)) ??
    allPaths[0] ??
    null
  );
}

export function decidePreview(
  path: string,
  content: string,
  allPaths: readonly string[],
): PreviewDecision {
  if (/\.md$/i.test(path)) return { kind: "markdown", reason: null };
  if (/\.svg$/i.test(path)) return { kind: "svg", reason: null };

  if (!/\.html?$/i.test(path)) {
    const entries = htmlEntries(allPaths);
    const whereToLook =
      entries.length > 0
        ? `整体效果请打开 ${entries[0]}。`
        : "这个工作区里没有 HTML 入口,所以没有可运行的整体效果。";

    return {
      kind: "none",
      reason: NEEDS_BUILD.test(path)
        ? `这是组件源码,单独一个文件没有独立效果。${whereToLook}`
        : `该文件类型没有可视化预览。${whereToLook}`,
    };
  }

  // HTML 引用了工作区里的模块 —— 交给 bundle.ts 现场编译
  const referencesLocalModule =
    /<script[^>]+\bsrc=["'](?!https?:|\/\/)[^"']+["']/i.test(content);
  if (referencesLocalModule) {
    return { kind: "project", reason: null };
  }

  return { kind: "html", reason: null };
}
