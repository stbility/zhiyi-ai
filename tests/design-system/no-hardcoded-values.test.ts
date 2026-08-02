import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 设计系统守卫。
 *
 * 目的:阻止「顺手写个颜色/圆角」逐步侵蚀设计系统。所有视觉值必须来自 token,
 * 通过 Tailwind 工具类或 var(--token) 使用,不得在组件里写死。
 *
 * 唯一豁免:src/styles/ —— 那里是从设计系统复制来的 token 真值源本身。
 */

const SRC = resolve(__dirname, "../../src");
const TOKENS_DIR = resolve(SRC, "styles");

/**
 * 唯一的写死颜色豁免:第三方品牌标识。
 *
 * Google 品牌规范要求其标识必须使用官方四色,不得改色 —— 换成设计系统的颜色
 * 反而违反对方准则。豁免范围严格限定为这一个文件,不扩大到任何组件。
 */
const BRAND_MARKS = resolve(SRC, "components/auth/BrandMarks.tsx");

/**
 * 第二处豁免:生成沙箱 iframe 文档的两个模块。
 *
 * 它们产出的是**独立文档**,跑在 sandbox 不给 allow-same-origin 的
 * 不透明源里,拿不到我们站点的任何样式表,自然也读不到 --token 变量。
 * 这些颜色不属于产品界面,而是那份独立文档自己的排版样式。
 *
 * 豁免严格限定到这两个文件。它们本身也不允许出现在产品界面里 ——
 * 任何组件想用颜色,仍然只能走 token。
 */
const SANDBOX_DOCS = [
  resolve(SRC, "lib/workspace/bundle.ts"),
  resolve(SRC, "lib/workspace/markdown.ts"),
];

function collectFiles(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (full.startsWith(TOKENS_DIR)) continue;
    if (full === BRAND_MARKS) continue;
    if (SANDBOX_DOCS.includes(full)) continue;
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full, exts));
    } else if (exts.some((e) => full.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function scan(pattern: RegExp, exts: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of collectFiles(SRC, exts)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      // 允许注释里出现示例值
      const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      if (pattern.test(code)) {
        violations.push({
          file: relative(SRC, file),
          line: index + 1,
          text: line.trim(),
        });
      }
      pattern.lastIndex = 0;
    });
  }
  return violations;
}

describe("设计系统守卫", () => {
  it("组件中不得出现写死的十六进制颜色", () => {
    expect(scan(/#[0-9a-f]{3,8}\b/i, [".tsx", ".ts"])).toEqual([]);
  });

  it("组件中不得出现写死的 rgb / rgba / hsl 颜色", () => {
    expect(scan(/\b(rgba?|hsla?)\s*\(/i, [".tsx", ".ts"])).toEqual([]);
  });

  it("组件中不得使用 Tailwind 任意值语法写死颜色", () => {
    // 形如 bg-[#123456] / text-[rgb(...)] —— 绕过 token 的写法
    expect(
      scan(/-\[\s*(#|rgba?\(|hsla?\()/i, [".tsx"]),
    ).toEqual([]);
  });

  it("组件中不得引用 Tailwind 默认调色板", () => {
    // 设计系统只有一个品牌色相 + 一组语义色,不允许混入 zinc/slate/indigo 等
    const palette =
      /\b(?:bg|text|border|ring|from|via|to|fill|stroke|divide|outline|shadow|accent|caret|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
    expect(scan(palette, [".tsx"])).toEqual([]);
  });
});
