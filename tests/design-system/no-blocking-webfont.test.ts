import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 外部字体不得出现在阻塞渲染的路径上。
 *
 * 起因是真实故障。tokens/fonts.css 里曾有一行:
 *   @import url('https://fonts.googleapis.com/css2?...')
 * 三件事叠在一起就成了灾难:
 *   1. CSS 的 @import 阻塞渲染,浏览器必须先拿到它才继续
 *   2. fonts.googleapis.com 在中国大陆不通,请求要等到 TCP 超时
 *   3. 首屏渲染与脚本执行因此一起卡住,水合迟迟完不成
 * 用户看到的是「网页很慢、按钮点很多下才生效」—— 而按钮本身没有任何问题,
 * 只是水合前事件还没挂上。
 *
 * 这条测试守住两点:CSS 里不许再出现外部 @import;layout 里引外部字体
 * 必须是非阻塞形式。
 */

const STYLES = resolve(__dirname, "../../src/styles");
const LAYOUT = resolve(__dirname, "../../src/app/layout.tsx");

function allCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...allCssFiles(full));
    else if (entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

describe("外部字体不得阻塞首屏", () => {
  it("样式表里不得出现指向外部域名的 @import", () => {
    const offenders = [
      ...allCssFiles(STYLES),
      resolve(__dirname, "../../src/app/globals.css"),
    ].filter((f) => {
      // 先剥掉注释 —— 说明「这里曾经有一行 @import」的文字不是违规
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      return /@import\s+(url\()?["']?https?:/i.test(code);
    });

    expect(offenders).toEqual([]);
  });

  it("layout 里的外部字体样式表必须是非阻塞的", () => {
    const layout = readFileSync(LAYOUT, "utf8");
    if (!layout.includes("fonts.googleapis.com")) return; // 不用外部字体也可以

    // 关键:media="print" 的样式表不参与首屏渲染,永远不会阻塞
    expect(layout).toMatch(/media="print"/);
    // 而且要在页面加载完成后才切成生效状态
    expect(layout).toContain("media='all'");
  });

  it("中文字体不依赖 webfont —— 取不到外部字体也要有像样的中文显示", () => {
    const type = readFileSync(resolve(STYLES, "tokens/typography.css"), "utf8");
    const zh = /--font-zh:([^;]+);/.exec(type)?.[1] ?? "";
    // 系统自带字体必须排在需要下载的 Noto Sans SC 之前
    expect(zh.indexOf("PingFang SC")).toBeGreaterThan(-1);
    expect(zh.indexOf("PingFang SC")).toBeLessThan(zh.indexOf("Noto Sans SC"));
    expect(zh).toContain("Microsoft YaHei");
  });
});
