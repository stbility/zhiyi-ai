import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 外部字体不得出现在阻塞渲染的路径上。
 * (README 进度守卫已迁移至 tests/app/readme-phase-sync.test.ts)
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
