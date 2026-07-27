import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Tailwind theme 映射测试。
 *
 * 背景:设计系统的 --radius-* / --shadow-* / --font-* / --ease-* 与 Tailwind v4 的
 * theme namespace 同名。最终取值依赖 CSS cascade layer 优先级(无层级声明优先于
 * @layer 声明)。这类跨层解析靠肉眼 review 看不出来,必须编译后断言。
 *
 * 本测试真实调用 Tailwind 编译 globals.css,断言:
 *   1. 每个工具类都指向设计系统 token,而不是 Tailwind 默认值或写死的字面量;
 *   2. 产物中不存在单条自引用声明(--x: var(--x)),该形态会被部分压缩器误处理。
 */

const ROOT = resolve(__dirname, "../..");
const TAILWIND_BIN = resolve(ROOT, "node_modules/.bin/tailwindcss");

/** 需要强制生成的工具类 —— 覆盖每一类 theme 映射 */
const UTILITIES = [
  "bg-canvas",
  "bg-surface-1",
  "bg-surface-2",
  "bg-surface-3",
  "bg-surface-4",
  "bg-brand",
  "bg-brand-tint",
  "text-fg",
  "text-fg-secondary",
  "text-fg-tertiary",
  "text-on-brand",
  "text-success",
  "text-warning",
  "text-error",
  "text-info",
  "border-border-default",
  "border-border-strong",
  "rounded-tag",
  "rounded-control",
  "rounded-card",
  "rounded-panel",
  "rounded-modal",
  "shadow-dropdown",
  "shadow-modal",
  "shadow-flyout",
  "shadow-sheet",
  "font-zh",
  "font-latin",
  "font-mono",
  "text-h1",
  "text-h2",
  "text-body",
  "text-caption",
  "ease-standard",
  "w-sidebar",
  "w-assistant",
  "max-w-reading",
];

let css = "";
let workdir = "";

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "zhiyi-theme-"));

  const fixture = join(workdir, "fixture.html");
  writeFileSync(fixture, `<div class="${UTILITIES.join(" ")}"></div>`, "utf8");

  const out = join(workdir, "out.css");
  execFileSync(
    TAILWIND_BIN,
    [
      "-i",
      resolve(ROOT, "src/app/globals.css"),
      "-o",
      out,
      "--content",
      fixture,
    ],
    { cwd: ROOT, stdio: "pipe" },
  );

  css = readFileSync(out, "utf8");
}, 120_000);

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

/** 取出某个工具类规则体 */
function ruleBody(selector: string): string {
  const match = css.match(
    new RegExp(`\\.${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
  );
  return match?.[1] ?? "";
}

describe("Tailwind theme 映射到设计系统 token", () => {
  it("每个被测工具类都成功生成", () => {
    const missing = UTILITIES.filter((u) => ruleBody(u) === "");
    expect(missing).toEqual([]);
  });

  it("表面与文字色指向设计系统变量,而非 Tailwind 默认调色板", () => {
    expect(ruleBody("bg-canvas")).toContain("var(--bg-canvas)");
    expect(ruleBody("bg-surface-2")).toContain("var(--surface-2)");
    expect(ruleBody("bg-brand")).toContain("var(--brand-primary)");
    expect(ruleBody("text-fg")).toContain("var(--text-primary)");
    expect(ruleBody("text-fg-tertiary")).toContain("var(--text-tertiary)");
    expect(ruleBody("border-border-default")).toContain("var(--border-default)");
  });

  it("圆角、阴影、字体族经 --ds-* 别名指向设计系统", () => {
    expect(ruleBody("rounded-card")).toContain("var(--ds-radius-card)");
    expect(ruleBody("rounded-panel")).toContain("var(--ds-radius-panel)");
    expect(ruleBody("shadow-modal")).toContain("var(--ds-shadow-modal)");
    expect(ruleBody("font-zh")).toContain("var(--ds-font-zh)");
    expect(ruleBody("ease-standard")).toContain("var(--ds-ease-standard)");
  });

  it("字号工具类同时带上设计系统定义的行高", () => {
    // @theme inline 会把行高内联为 line-height: var(--tw-leading, <设计系统行高 token>)
    expect(ruleBody("text-h1")).toContain("var(--text-h1-size)");
    expect(ruleBody("text-h1")).toContain("var(--text-h1-line)");
    expect(ruleBody("text-h2")).toContain("var(--text-h2-size)");
    expect(ruleBody("text-h2")).toContain("var(--text-h2-line)");
    expect(ruleBody("text-body")).toContain("var(--text-body-size)");
    expect(ruleBody("text-body")).toContain("var(--text-body-line)");
    expect(ruleBody("text-caption")).toContain("var(--text-caption-size)");
    expect(ruleBody("text-caption")).toContain("var(--text-caption-line)");
  });

  it("布局宽度指向设计系统固定值", () => {
    expect(ruleBody("w-sidebar")).toContain("var(--ds-sidebar-width)");
    expect(ruleBody("w-assistant")).toContain("var(--ds-assistant-width)");
    expect(ruleBody("max-w-reading")).toContain("var(--reading-measure)");
  });

  it("别名层完整,且每条别名都指向设计系统原名", () => {
    expect(css).toContain("--ds-radius-card: var(--radius-card)");
    expect(css).toContain("--ds-font-zh: var(--font-zh)");
    expect(css).toContain("--ds-shadow-modal: var(--shadow-modal)");
  });

  it("产物中不存在单条自引用声明", () => {
    const selfRefs = [
      ...css.matchAll(/(--[a-z0-9-]+)\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/gi),
    ]
      .filter((m) => m[1] === m[2])
      .map((m) => m[0]);

    expect(selfRefs).toEqual([]);
  });

  it("设计系统 token 的字面值确实进入产物", () => {
    const normalized = css.toLowerCase();
    expect(normalized).toContain("#07080b");
    expect(normalized).toContain("#6977e8");
    expect(normalized).toContain("248px");
  });
});
