import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 连接 GitHub 这条路必须始终走得通。
 *
 * 真实死锁(用户实际撞到的):
 *   slug 向 GitHub 查证失败(401)
 *     → 集成页不生成安装链接
 *       → 用户拿不到带 state 的地址
 *         → 只能从 GitHub 应用页自己安装
 *           → 回调没有 state → 被拒绝
 * 三道都是防线,单看每一道都合理,合起来把唯一能走的路堵死了。
 * 用户看到的是「Git 仓库 未连接 / 暂时无法连接」,然后无路可走。
 *
 * 这类问题测试很难用行为覆盖(要真连 GitHub),所以这里守的是
 * **结构性保证**:每一道防线都必须留一条出路。
 */

const ROOT = resolve(__dirname, "../..");
const CALLBACK = readFileSync(
  resolve(ROOT, "src/app/api/integrations/github/callback/route.ts"),
  "utf8",
);
const CARD = readFileSync(
  resolve(ROOT, "src/components/app/GitConnection.tsx"),
  "utf8",
);
const GITHUB = readFileSync(
  resolve(ROOT, "src/lib/integrations/github.ts"),
  "utf8",
);

/** 去掉注释再查,避免把"记录踩过的坑"的说明误判成代码 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("环境变量的首尾空白", () => {
  it("Client ID 与私钥读进来就 trim", () => {
    // 从 GitHub 界面复制时末尾极容易带换行,Vercel 原样存下来。
    // 带空白的 iss 会被 GitHub 直接拒(401),而用户核对时看到的是
    // 同样的字符串,怎么看都"填对了" —— 这类问题排查极其耗时。
    const c = code(GITHUB);
    expect(c).toMatch(/GITHUB_APP_CLIENT_ID"\]\?\.trim\(\)/);
    expect(c).toMatch(/GITHUB_APP_PRIVATE_KEY"\]\?\.trim\(\)/);
    expect(c).toMatch(/GITHUB_APP_SLUG"\]\?\.trim\(\)/);
  });
});

describe("回调:没有 state 也要能完成连接", () => {
  it("state 缺失时退回到当前登录用户自己的组织", () => {
    const c = code(CALLBACK);
    // 用户从 GitHub 应用页直接安装时不会带 state ——
    // 硬性要求 state 会让这条路彻底走不通
    expect(c).toContain("getMyOrganizations");
    expect(c).toMatch(/role === "owner" \|\| o\.role === "admin"/);
  });

  it("但有 state 时仍然校验,不通过就拒绝", () => {
    // 有兜底不等于放松已经握在手里的证据
    const c = code(CALLBACK);
    expect(c).toMatch(/if \(state\)[\s\S]{0,200}verifyState\(state\)/);
    expect(c).toMatch(/if \(!checked\.ok\) return back/);
  });

  it("没有可管理的组织时如实拒绝,不静默绑到别处", () => {
    expect(code(CALLBACK)).toContain("没有管理员权限");
  });
});

describe("卡片:拿不到安装地址时仍要给出路", () => {
  it("提供 GitHub 官方安装入口,而不是只说一句「暂时无法连接」", () => {
    // 「没有按钮」和「没有出路」是两回事
    expect(CARD).toContain("https://github.com/settings/installations");
    expect(CARD).toContain("去 GitHub 安装应用");
  });

  it("同时说明装完会自动跳回来 —— 否则用户不知道下一步", () => {
    expect(CARD).toContain("跳回这里");
  });

  it("仍然不生成拼错 slug 的假链接", () => {
    // 这条不能因为加了出路就放松:一个必然 404 的按钮比没有按钮更糟
    expect(CARD).not.toMatch(/href=\{installHref \?\? "#"\}/);
  });
});
