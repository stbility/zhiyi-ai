import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Git 仓库连接卡片的两条守卫,都来自用户实测。
 *
 *   1. 「编辑时插入了两遍:有两个 Git 仓库页面链接」
 *   2. 「连接 GitHub 打开跳转 404」
 *
 * 第二条尤其值得记:代码和它自己的注释是**矛盾**的。
 * page.tsx 里写着「取不到就不生成链接」,但 getAppSlug() 在查询失败时
 * 会回退到环境变量里的 GITHUB_APP_SLUG 并当作结果返回,于是 slug 非空、
 * 链接照样生成 —— 指向一个 slug 可能根本不对的地址。
 *
 * 用户点下去落在 GitHub 的 404 页上,而那个页面不会告诉他
 * 「是你们那边的环境变量填错了」。他只会以为这个功能坏了。
 */

const read = (p: string) => readFileSync(resolve(__dirname, "../../", p), "utf8");

const CARD_RAW = read("src/components/app/GitConnection.tsx");
const PAGE = read("src/app/(app)/settings/integrations/page.tsx");

/**
 * 断言前先把注释剥掉。
 *
 * 这一步是必须的,而且是被自己绊了一跤才加上的:第一版守卫直接在整份
 * 源码上数「未能向 GitHub 查证应用地址」出现几次,结果数到 2 —— 其中一处
 * 是我为了解释这个 bug 而写的注释。**守卫应该守渲染出去的东西,
 * 不是守我写了什么注释**;否则每写一句注释就可能误报一次。
 */
const 去注释 = (code: string) =>
  code.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const CARD = 去注释(CARD_RAW);

describe("卡片里同一块内容只能出现一次", () => {
  it("slug 未查证的警告只渲染一次", () => {
    // 数的是渲染条件本身,不是那句文案 —— 文案在「没有按钮」的说明里
    // 也会出现一次,那是另一件事
    const 次数 =
      CARD.split('configured && slugSource !== "github" && slugError').length - 1;
    expect(次数, `这段警告渲染了 ${次数} 次`).toBe(1);
  });

  it("标题行里只有标题和状态标签", () => {
    // 重复的那一份曾经被插进标题的 flex 容器里 —— 一个警告段落被当成
    // flex 子项排在标题旁边,标题行的布局跟着一起坏。
    const 标题行 = CARD.slice(
      CARD.indexOf('<div className="mb-1 flex flex-wrap items-center gap-2">'),
      CARD.indexOf("<p className=\"text-fg-secondary text-caption mb-4\">"),
    );
    expect(标题行.length).toBeGreaterThan(0);
    expect(标题行, "标题行里又混进了警告段落").not.toMatch(/未能向 GitHub/);
  });

  it("连接按钮只有一个", () => {
    const 次数 = CARD.split(">\n            连接 GitHub").length - 1;
    expect(次数).toBeLessThanOrEqual(1);
  });
});

describe("安装链接只能用查证过的 slug 拼", () => {
  it("必须校验 source === \"github\"", () => {
    // 光判 slug 非空是不够的:查询失败时它是环境变量里那个未经查证的值
    expect(PAGE).toMatch(/slugResult\.source === "github"/);
  });

  it("环境变量回退值不得单独用来拼链接", () => {
    // 形如 `slugResult.slug ? installUrl(...)` 的写法就是那个 bug 本身
    expect(
      PAGE,
      "又改回了「只要有 slug 就拼链接」—— 那正是 404 的成因",
    ).not.toMatch(/const installHref = slugResult\.slug\s*\n?\s*\?/);
  });

  it("拼不出链接时不渲染可点的按钮", () => {
    // 一个必然 404 的按钮,比没有按钮更糟
    expect(CARD).toMatch(/installHref \? \(/);
    expect(CARD, "又出现了 href 兜底成 # 的写法").not.toMatch(
      /href=\{installHref \?\? "#"\}/,
    );
  });

  it("拼不出链接时的说明不写「请稍后重试」", () => {
    // 401 这类是配置问题,重试一万次也一样 —— 那句话只会让人白等。
    // 注释里可以提它(那是在记为什么删掉),渲染出去的文案里不行。
    expect(CARD).not.toMatch(/请稍后重试/);
  });
});

describe("回调结果贴着它对应的动作,不浮在顶部", () => {
  it("notice 排在描述段之后、动作区之前", () => {
    // 此前它紧跟标题浮在卡片最上面,读起来像整页出了错 ——
    // 而它其实只是「刚才那次连接的回执」。位置本身就是信息。
    const 描述 = CARD.indexOf("连接后,智能体可以直接读写你授权的仓库");
    const 回执 = CARD.indexOf("notice?.error");
    // 用动作区独有的文案定位。`{!configured ? (` 在上面的状态标签里
    // 也出现过一次,拿它当锚点会定位到标题行 —— 我第一次就踩了这个,
    // 断言因此报了一个与事实相反的「回执跑到动作区后面了」。
    const 动作 = CARD.indexOf("服务端尚未配置 GitHub App");
    expect(描述).toBeGreaterThan(-1);
    expect(回执).toBeGreaterThan(-1);
    expect(动作).toBeGreaterThan(-1);
    expect(回执, "回执又浮到描述前面去了").toBeGreaterThan(描述);
    expect(回执, "回执跑到动作区后面了").toBeLessThan(动作);
  });
});

describe("回调缺 installation_id 时要说得清", () => {
  const CALLBACK = read("src/app/api/integrations/github/callback/route.ts");

  it("说出 GitHub 实际带回了哪些参数", () => {
    // 只说「没有返回安装标识」是个死胡同:用户配好了回调地址、
    // GitHub 也确实跳回来了,却被告知缺了个他没听说过的东西。
    expect(CALLBACK).toMatch(/searchParams\.keys\(\)/);
  });

  it("区分「走了授权流程」和「什么都没带」—— 这是两件事", () => {
    expect(CALLBACK).toMatch(/includes\("code"\)/);
  });

  it("指向 GitHub App 设置页里真正管这件事的那个开关", () => {
    // installation_id 只在安装流程出现,对应 Setup URL;
    // Callback URL 对应的是授权流程。两条路都走同一个地址需要勾那个选项。
    expect(CALLBACK).toMatch(/Setup URL/);
    expect(CALLBACK).toMatch(/Request user authorization/);
  });
});
