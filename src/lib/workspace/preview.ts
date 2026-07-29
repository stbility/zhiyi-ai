/**
 * 工作区产物的预览能力判定。
 *
 * 「产出了文件」和「看到了效果」是两回事。用户要的是后者 ——
 * 一堆代码摆在那里,和贴在对话气泡里没有本质区别。
 *
 * 但能预览什么是有边界的,必须说清楚,不能让用户以为点开就一定看得见:
 *   - 单文件 HTML:可以直接渲染
 *   - 多文件项目(index.html + src/*.jsx):浏览器解析不了裸 JSX,
 *     也没有打包步骤,预览出来会是空白。与其给一个空白页面,不如明说
 *     它需要构建 —— 那才是事实,而且能指出下一步该怎么做。
 */

export type PreviewKind = "html" | "none";

export interface PreviewDecision {
  readonly kind: PreviewKind;
  /** 不能预览时的原因,直接展示给用户 */
  readonly reason: string | null;
}

/** 需要构建工具才能运行的源码类型 —— 直接丢进浏览器只会是空白 */
const NEEDS_BUILD = /\.(jsx|tsx|ts|vue|svelte|astro)$/i;

export function decidePreview(
  path: string,
  content: string,
  allPaths: readonly string[],
): PreviewDecision {
  if (!/\.html?$/i.test(path)) {
    return {
      kind: "none",
      reason: NEEDS_BUILD.test(path)
        ? "这是源码文件,需要经过构建(如 Vite、webpack)才能运行,浏览器不能直接渲染。"
        : "该文件类型没有可视化预览。",
    };
  }

  // HTML 引用了需要构建的模块 —— 预览出来必然空白,不如提前说明
  const referencesUnbuilt = /<script[^>]+src=["'][^"']+\.(jsx|tsx|ts)["']/i.test(
    content,
  );
  if (referencesUnbuilt) {
    const sources = allPaths.filter((p) => NEEDS_BUILD.test(p));
    return {
      kind: "none",
      reason:
        "这个页面引用了需要构建的源码" +
        (sources.length > 0 ? `(${sources.join("、")})` : "") +
        ",浏览器无法直接运行,预览会是空白。" +
        "让智能体改成单文件 HTML(用 CDN 引入 React 与 Babel),即可直接预览。",
    };
  }

  return { kind: "html", reason: null };
}
