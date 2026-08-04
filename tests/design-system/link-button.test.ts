import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 长得像按钮的链接必须走同一个组件。
 *
 * 用户的原话:「按钮系统不是原生组件,是代理拼接假的按钮,不一致」。
 *
 * 我先用浏览器实测过:`<button>` 和套了同一套类名的 `<a>`,
 * 计算样式**完全相同**(主要形态都是 rgb(255,255,255) 文字 +
 * rgb(105,119,232) 背景),全局的 a{color:...} 并没有压过 Tailwind。
 * 所以这不是「现在看起来就不对」—— 我原本猜的那个原因是错的。
 *
 * 真正的问题在**构造**:别处用 <Button> 组件,而这些地方手抄类名。
 * Button 内部一旦演进(加 loading、改 focus 环、换 disabled 处理),
 * 组件那边自动跟上,手抄的那份原地不动 —— 不一致是迟早的,只是还没发生。
 *
 * 所以守的是「不许再手抄」,而不是「颜色对不对」。
 */

const SRC = resolve(__dirname, "../../src");

/** 允许直接用 buttonClasses 的地方 */
const 豁免 = [
  // 它自己就是那个函数
  "components/primitives/Button.tsx",
  // 它是把函数包成组件的那一层
  "components/primitives/LinkButton.tsx",
  // 同页锚点:next/link 对 #anchor 没有意义,external 又会新开标签页,
  // 两个都不对 —— 这里用原生 <a> 是正确的
  "app/(marketing)/page.tsx",
];

function 所有源文件(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...所有源文件(full));
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("按钮样式的唯一来源", () => {
  it("除豁免外没有地方手抄 buttonClasses", () => {
    const 违规 = 所有源文件(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("buttonClasses"))
      .map((f) => relative(SRC, f))
      .filter((f) => !豁免.includes(f));

    expect(
      违规,
      `以下文件在手抄按钮类名,应改用 <LinkButton> 或 <Button>:${违规.join("、")}`,
    ).toEqual([]);
  });

  it("LinkButton 的样式来自 buttonClasses,不是另写一套", () => {
    // 另写一套的话,两种按钮迟早分叉 —— 那正是这条测试要防的事
    const src = readFileSync(
      resolve(SRC, "components/primitives/LinkButton.tsx"),
      "utf8",
    );
    expect(src).toContain("buttonClasses");
    expect(src).not.toMatch(/bg-brand|text-on-brand|rounded-control/);
  });

  it("外部链接新开标签页时带 noopener —— 否则新页面能操作我们这一页", () => {
    const src = readFileSync(
      resolve(SRC, "components/primitives/LinkButton.tsx"),
      "utf8",
    );
    expect(src).toMatch(/target="_blank"[\s\S]{0,80}rel="noopener noreferrer"/);
  });
});
