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
  return (
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // 只剥**行首**的 // 注释。
      //
      // 原来写的是 /\/\/.*$/gm —— 它会把 https://github.com/... 里的
      // 那两个斜杠也当成注释起点,从那里截到行尾,于是源码里明明有的
      // URL 在这里"消失"了,测试红在一个其实正确的实现上。
      // 剥注释是为了不把「记录踩过的坑」的说明误判成违规,
      // 而那些说明本来就都在行首。
      .replace(/^\s*\/\/.*$/gm, "")
  );
}

describe("环境变量的首尾空白", () => {
  it("Client ID 与私钥读进来就 trim", () => {
    // 从 GitHub 界面复制时末尾极容易带换行,Vercel 原样存下来。
    // 带空白的 iss 会被 GitHub 直接拒(401),而用户核对时看到的是
    // 同样的字符串,怎么看都"填对了" —— 这类问题排查极其耗时。
    const c = code(GITHUB);
    expect(c).toMatch(/GITHUB_APP_CLIENT_ID"\]\?\.trim\(\)/);
    expect(c).toMatch(/GITHUB_APP_PRIVATE_KEY"\]\?\.trim\(\)/);
    // slug 不再在这里 trim —— 它改走 normalizeSlug(),那个函数内部 trim,
    // 而且顺带把用户粘进来的整条网址还原成名字。
    // 守卫改成守**行为**而不是守某一行长什么样:源码正则会把
    // 「换了个更好的实现」误报成「保护没了」。
    expect(c).toMatch(/normalizeSlug\(process\.env\["GITHUB_APP_SLUG"\]\)/);
    // normalizeSlug 自己 trim 这件事,由 tests/integrations/normalize-slug.test.ts
    // 直接调函数验证 —— 这个文件是纯源码检查,没有中和 server-only,
    // 在这里 import github.ts 会直接抛错。
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

describe("卡片:不给指向别处的链接", () => {
  it("不再指向 settings/installations —— 那是已安装应用的管理页,不是本应用的安装入口", () => {
    // 用户点过去只会看到一个和我们无关的列表。官方的安装地址只有
    // github.com/apps/<slug>/installations/new 一种形式。
    // 来源:docs.github.com/apps/sharing-github-apps/sharing-your-github-app
    // 剥掉注释再查:注释里记着「这里曾经指向那个地址、为什么是错的」,
    // 那是有价值的说明,不该被当成违规
    expect(code(CARD)).not.toContain("github.com/settings/installations");
  });

  it("仍然不生成拼错 slug 的假链接", () => {
    expect(CARD).not.toMatch(/href=\{installHref \?\? "#"\}/);
  });
});

describe("slug 的两条查证路径", () => {
  const GH = code(GITHUB);

  it("GET /app 走不通时,用公开页免鉴权查证环境变量里的 slug", () => {
    // 关键:GitHub App 的公开页 github.com/apps/<slug> 不需要认证 ——
    // 存在 200、不存在 404。实测 zhiyi-ai-repo → 200、zhiyi-ai → 404。
    // 之前只认 GET /app,凭据一配错就彻底没有按钮;
    // 而安装这条路本来只需要 slug,不需要我们能认证。
    expect(GH).toMatch(/github\.com\/apps\//);
    expect(GH).toMatch(/method: "HEAD"/);
  });

  it("查证不过的 slug 一律不返回 —— 未经查证的值正是之前跳 404 的原因", () => {
    expect(GH).toMatch(/source: "none"/);
    // 不能再有「拿到就用」的 env 档
    expect(GH).not.toMatch(/source: "env"/);
  });

  it("查证过的来源要能区分权威程度", () => {
    expect(GH).toMatch(/source: "github"/);
    expect(GH).toMatch(/source: "public"/);
  });
});
