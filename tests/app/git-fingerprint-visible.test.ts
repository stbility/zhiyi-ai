import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 凭据没通过验证时,指纹必须**在实际走到的那个分支上**显示出来。
 *
 * 这条守卫来自我自己犯的一个错:指纹块第一版只放进了「拿不到安装地址」
 * 那一支。而 slug 现在能免鉴权从公开页查证 —— 私钥不对时照样拿得到
 * 安装地址,走的是**另一支**。于是这块刚做好的诊断一次都没渲染过,
 * 用户看到的还是那句读不懂的 401,而我以为已经给了他工具。
 *
 * 做了但接不上,和没做是一样的 —— 甚至更糟,因为我会以为这条已经解决。
 */

const CARD = readFileSync(
  resolve(__dirname, "../../src/components/app/GitConnection.tsx"),
  "utf8",
);

/** 只看渲染出去的东西,不看我写了什么注释 */
const 去注释 = (code: string) =>
  code.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const RENDERED = 去注释(CARD);

describe("指纹在两个分支上都要显示", () => {
  it("有安装地址那一支显示 —— 这正是私钥不对时实际走到的分支", () => {
    // slug 免鉴权可查,所以私钥坏掉时按钮照样出现,走的就是这一支
    // 切片只能覆盖**这一支**。
    //
    // 第一版我从 `installHref ? (` 一路取到 `<GitManualConnect />`,
    // 那把两个分支都圈进去了 —— 于是把这一支的指纹整块删掉,
    // 断言仍然命中第二支里的那一个,测试照绿。变异检验当场抓到。
    // 边界取到 `) : (`,也就是这一支结束、另一支开始的地方。
    const 起 = RENDERED.indexOf("installHref ? (");
    const 止 = RENDERED.indexOf(") : (", 起);
    const 分支 = RENDERED.slice(起, 止);
    expect(止).toBeGreaterThan(起);
    expect(分支, "指纹不在「有安装地址」这一支里").toMatch(/\{指纹对照\}/);
    expect(分支, "切片没有停在分支边界上").not.toMatch(/GitManualConnect/);
  });

  it("拿不到安装地址那一支也显示", () => {
    const 分支 = RENDERED.slice(RENDERED.indexOf("<GitManualConnect />") - 200);
    expect(分支).toMatch(/\{指纹对照\}/);
  });

  it("只在凭据没通过验证时显示 —— 一切正常时不该出现", () => {
    // 正向对照:少了这条,一个无条件永远显示指纹的实现也能通过上面两条,
    // 而那会在连接成功的页面上挂一串莫名其妙的哈希
    expect(RENDERED).toMatch(/slugError && keyFingerprint \?/);
  });

  it("指纹是公开值,但私钥本身一个字都不传给前端", () => {
    expect(RENDERED).not.toMatch(/privateKey/);
    expect(RENDERED).not.toMatch(/BEGIN RSA/);
  });
});
