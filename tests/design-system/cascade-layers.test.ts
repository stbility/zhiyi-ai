import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CSS cascade layer 归属测试。
 *
 * 背景:CSS 规范规定「无层级声明优先于任何 @layer 声明」。这条规则在本项目里
 * 被用了两次,方向相反,必须各自锁死:
 *
 *   1. tokens/*.css 必须保持无层级 —— 它要压过 Tailwind 输出在 @layer theme
 *      里的同名 theme 变量,设计 token 才是最终值。
 *
 *   2. base.css 必须放进 @layer base —— 它含全局 `a { color }`。若无层级,
 *      会压过 @layer utilities 里的 Tailwind 工具类,导致任何 <a> 上的 text-*
 *      失效。实际后果:做成链接的主按钮文字色被强制成品牌色,与品牌色背景
 *      重合,按钮文字完全看不见。此问题已在浏览器实测复现并修复。
 */

const GLOBALS = resolve(__dirname, "../../src/app/globals.css");

function readGlobals(): string {
  return readFileSync(GLOBALS, "utf8");
}

/** 提取所有 @import 语句(去掉注释,避免注释里的示例被匹配) */
function imports(): string[] {
  const css = readGlobals().replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/@import\s+[^;]+;/g)].map((m) => m[0]);
}

describe("cascade layer 归属", () => {
  it("base.css 必须导入到 layer(base),否则全局 a 颜色会压过工具类", () => {
    const line = imports().find((i) => i.includes("base.css"));
    expect(line, "未找到 base.css 的 @import").toBeDefined();
    expect(line).toMatch(/layer\(\s*base\s*\)/);
  });

  it("tokens/*.css 必须保持无层级,才能压过 Tailwind 的 theme 层", () => {
    const tokenImports = imports().filter((i) => i.includes("tokens/"));
    expect(tokenImports.length).toBeGreaterThan(0);

    for (const line of tokenImports) {
      expect(line, `${line} 不应带 layer()`).not.toMatch(/layer\(/);
    }
  });

  it("远程字体 @import 必须排在 tailwindcss 之前", () => {
    // CSS 规范要求 @import 位于所有规则之前;内联后位置非法会被浏览器静默丢弃
    const all = imports();
    const fontsIndex = all.findIndex((i) => i.includes("fonts.css"));
    const tailwindIndex = all.findIndex((i) => i.includes('"tailwindcss"'));

    expect(fontsIndex).toBeGreaterThanOrEqual(0);
    expect(tailwindIndex).toBeGreaterThanOrEqual(0);
    expect(fontsIndex).toBeLessThan(tailwindIndex);
  });
});
