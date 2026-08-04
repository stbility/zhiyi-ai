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

describe("卡片上不摊诊断细节", () => {
  /**
   * 用户的原话:「删除 保持干净」。
   *
   * 卡片上曾经同时挂着三段东西:slug 未查证的警告、GitHub 的 401 原文、
   * 以及一段解释「为什么这里没有连接入口」的话。三段说的是同一件事,
   * 铺开之后把整张卡片淹掉了,而它们本来是**部署侧**要看的东西。
   *
   * 现在:卡片只留一句短话,诊断全部进服务端日志(logger.warn 已经记着)。
   * 这和「系统消息与内容分走不同通道」是同一条原则 ——
   * 日志是给运维的通道,卡片是给用户的通道。
   */
  const 不许出现 = [
    /未能向 GitHub 查证应用地址/,
    /GITHUB_APP_CLIENT_ID 填成了 OAuth App/,
    /只会落在 GitHub 的 404 页面上/,
    /下面用的是环境变量里填的值/,
  ];

  for (const 句 of 不许出现) {
    it(`卡片上不出现「${句.source}」`, () => {
      expect(CARD).not.toMatch(句);
    });
  }

  it("没有连接入口时只留一句短话", () => {
    expect(CARD).toMatch(/暂时无法连接,详情见服务端日志。/);
  });

  it("已经用不上的 slug 属性不留在接口里", () => {
    // 删了渲染却留着属性,下一个人会以为它还有用,再把那几段话接回去
    expect(CARD).not.toMatch(/slugSource|slugError/);
  });

  it("诊断没有丢,只是换了通道 —— 服务端仍然记日志", () => {
    const GH = read("src/lib/integrations/github.ts");
    expect(GH).toMatch(/logger\.warn/);
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
    // 401 这类是配置问题,重试一万次也一样 —— 那句话只会让人白等
    expect(CARD).not.toMatch(/请稍后重试/);
  });
});

describe("回调结果贴着它对应的动作,不浮在顶部", () => {
  it("回执排在描述段之后、动作区之前", () => {
    // 此前它紧跟标题浮在卡片最上面,读起来像整页出了错 ——
    // 而它其实只是「刚才那次连接的回执」。位置本身就是信息。
    const 描述 = CARD.indexOf("连接后,智能体可以直接读写你授权的仓库");
    const 回执 = CARD.indexOf("notice?.error");
    // 用动作区独有的文案定位。`{!configured ? (` 在上面的状态标签里
    // 也出现过一次,拿它当锚点会定位到标题行。
    const 动作 = CARD.indexOf("服务端尚未配置 GitHub App");
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

describe("401 要以 GitHub 的原话为准", () => {
  const GH = read("src/lib/integrations/github.ts");

  it("401 分支读响应体,不再用写死的猜测盖掉", () => {
    // 这一支此前完全不读 body。而 GitHub 的 401 会区分几种完全不同的
    // 原因(私钥解析不了 / iss 不对应任何 App / 时钟偏差 / 凭据不匹配),
    // 每种对应不同的修法。扔掉它,等于让用户反复核对同一个可能没错的地方。
    const 分支 = GH.slice(
      GH.indexOf("response.status === 401"),
      GH.indexOf("向 GitHub 查询应用信息失败"),
    );
    expect(分支).toMatch(/readError\(response\)/);
  });

  it("回显 Client ID(公开值),但一个字都不显示私钥", () => {
    expect(GH).toMatch(/config\.clientId\}/);
    expect(GH, "私钥被回显了").not.toMatch(/\$\{config\.privateKey\}/);
  });

  it("私钥能不能签名,不联网就先判掉", () => {
    // 「私钥格式不对,连 JWT 都签不出来」和「JWT 签好了 GitHub 不认」
    // 是两件事,两个修法。混成一句「GitHub 拒绝了应用凭据」,
    // 用户会被支去核对 Client ID —— 而真正坏的可能是私钥。
    expect(GH).toMatch(/function checkPrivateKey/);
    expect(GH).toMatch(/这一步还没联网/);
  });
});
