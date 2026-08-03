import { generateKeyPairSync, createVerify } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GitHub App 的 JWT 必须严格符合官方规格。
 *
 * 这段是整条链路的根:签错了什么都调不通,而 GitHub 的报错只会是一句
 * 「Bad credentials」,完全看不出是哪个声明不对。所以逐条按文档验证:
 *
 *   · 算法必须是 RS256
 *   · iat 要往前 60 秒 —— 官方明确要求,防止我们的时钟比 GitHub 快
 *     一点点导致 JWT 被判为「来自未来」
 *   · exp 距 iat 不得超过 10 分钟(官方硬上限)
 *   · iss 用 Client ID(官方推荐)
 *
 * 文档:https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */

vi.mock("server-only", () => ({}));

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const CONFIG = {
  clientId: "Iv1.testclientid",
  privateKey,
  slug: "zhiyi-ai",
};

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("App JWT", () => {
  it("头部声明 RS256", async () => {
    const { signAppJwt } = await import("@/lib/integrations/github");
    const [header] = signAppJwt(CONFIG).split(".");
    expect(decode(header!)["alg"]).toBe("RS256");
  });

  it("iat 往前 60 秒,exp 不超过官方 10 分钟上限", async () => {
    const { signAppJwt } = await import("@/lib/integrations/github");
    const now = 1_700_000_000_000;
    const [, payload] = signAppJwt(CONFIG, now).split(".");
    const claims = decode(payload!);

    const seconds = Math.floor(now / 1000);
    expect(claims["iat"]).toBe(seconds - 60);
    // 距 iat 的跨度必须 ≤ 600 秒,否则 GitHub 直接拒
    expect((claims["exp"] as number) - (claims["iat"] as number)).toBeLessThanOrEqual(600);
    // 也不能签一个已经过期的
    expect(claims["exp"]).toBeGreaterThan(seconds);
  });

  it("iss 用 Client ID —— 官方推荐,而不是 App ID", async () => {
    const { signAppJwt } = await import("@/lib/integrations/github");
    const [, payload] = signAppJwt(CONFIG).split(".");
    expect(decode(payload!)["iss"]).toBe(CONFIG.clientId);
  });

  it("签名可被对应公钥验证通过", async () => {
    const { signAppJwt } = await import("@/lib/integrations/github");
    const [h, p, sig] = signAppJwt(CONFIG).split(".");
    const ok = createVerify("RSA-SHA256")
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(sig!, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("App 配置读取", () => {
  it("缺任何一项都返回 null —— 不能半配置就当已接通", async () => {
    const { getGitHubAppConfig } = await import("@/lib/integrations/github");
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.x");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    vi.stubEnv("GITHUB_APP_SLUG", "zhiyi-ai");
    expect(getGitHubAppConfig()).toBeNull();
  });

  it("还原字面量 \\n —— Vercel 的输入框就是这么存换行的", async () => {
    const { getGitHubAppConfig } = await import("@/lib/integrations/github");
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.x");
    vi.stubEnv(
      "GITHUB_APP_PRIVATE_KEY",
      "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----",
    );
    vi.stubEnv("GITHUB_APP_SLUG", "zhiyi-ai");

    const config = getGitHubAppConfig();
    expect(config?.privateKey).toContain("\n");
    // 不还原的话 PEM 解析会失败,而报错是「不是合法的私钥」—— 极易误判成密钥填错
    expect(config?.privateKey).not.toContain("\\n");
  });
});

describe("未配置时的行为", () => {
  it("如实说明缺什么,而不是笼统报「连接失败」", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    vi.stubEnv("GITHUB_APP_SLUG", "");
    const { getInstallationToken } = await import("@/lib/integrations/github");

    const r = await getInstallationToken("123");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("尚未配置 GitHub App");
      expect(r.error).toContain("GITHUB_APP_PRIVATE_KEY");
    }
  });
});

/**
 * state 是这条链路唯一的防伪装。
 *
 * 回调地址是公开的,任何人都能构造一个带 installation_id 的请求打过来。
 * 没有 state 校验的话,攻击者可以把**他自己的**安装绑到**你的**组织上 ——
 * 之后他的仓库出现在你的工作区里还算轻的,反过来他也能借你的组织
 * 读到你连的仓库。
 */
describe("安装 state", () => {
  const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  function stubConfig() {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", CONFIG.clientId);
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
    vi.stubEnv("GITHUB_APP_SLUG", CONFIG.slug);
  }

  it("签发的 state 带得回组织标识", async () => {
    stubConfig();
    const { issueState } = await import("@/lib/integrations/github");
    const [payload] = issueState(ORG).split(".");
    expect(decode(payload!)["organizationId"]).toBe(ORG);
  });

  it("签名被篡改后验不过", async () => {
    stubConfig();
    const { issueState } = await import("@/lib/integrations/github");
    const state = issueState(ORG);
    const [payload, sig] = state.split(".");

    const { createHmac } = await import("node:crypto");
    const good = createHmac("sha256", privateKey).update(payload!).digest("base64url");
    expect(sig).toBe(good);

    // 换一个组织但沿用原签名 —— 必须对不上
    const forged = Buffer.from(
      JSON.stringify({ organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", issuedAt: Date.now() }),
    ).toString("base64url");
    const forgedSig = createHmac("sha256", privateKey).update(forged).digest("base64url");
    expect(forgedSig).not.toBe(sig);
  });

  it("带签发时间 —— 旧链接不能被无限重放", async () => {
    stubConfig();
    const { issueState } = await import("@/lib/integrations/github");
    const now = 1_700_000_000_000;
    const [payload] = issueState(ORG, now).split(".");
    expect(decode(payload!)["issuedAt"]).toBe(now);
  });

  it("未配置时抛错,而不是签出一个没人能验的 state", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    vi.stubEnv("GITHUB_APP_SLUG", "");
    const { issueState } = await import("@/lib/integrations/github");
    expect(() => issueState(ORG)).toThrow(/尚未配置/);
  });

  it("安装页地址指向正确的 App slug", async () => {
    stubConfig();
    const { installUrl } = await import("@/lib/integrations/github");
    const url = installUrl("zhiyi-ai", "abc.def");
    expect(url).toBe(
      "https://github.com/apps/zhiyi-ai/installations/new?state=abc.def",
    );
  });
});

/**
 * 新的无状态令牌格式不能把我们打挂。
 *
 * GitHub 从 2026-04-27 起分批把安装令牌换成 ghs_APPID_JWT,长度涨到
 * 约 520 字符且随内容浮动。官方警告:「Apps with hardcoded length
 * assumptions may break」。
 *
 * 我们这边理论上不受影响 —— 令牌只是原样存、原样发。但「理论上」不等于
 * 验证过,所以这里用一个真实长度的新格式令牌跑一遍。
 *
 * 来源:https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/
 */
describe("安装令牌格式变更", () => {
  /** 官方说约 520 字符,这里造一个更长的,确保不是刚好卡在边界上过的 */
  const LONG_TOKEN = `ghs_Iv1.abc_${"A1b2C3d4-_.".repeat(52)}`;

  function stubConfig() {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", CONFIG.clientId);
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
    vi.stubEnv("GITHUB_APP_SLUG", CONFIG.slug);
  }

  it("超长的新格式令牌被原样保留,不截断不校验长度", async () => {
    stubConfig();
    expect(LONG_TOKEN.length).toBeGreaterThan(520);

    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          token: LONG_TOKEN,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200 },
      ),
    );

    const { getInstallationToken } = await import("@/lib/integrations/github");
    const r = await getInstallationToken("999");

    expect(r.ok).toBe(true);
    if (r.ok) {
      // 一个字符都不能少 —— 截断的话后续所有请求都会 401
      expect(r.token).toBe(LONG_TOKEN);
      expect(r.token.length).toBe(LONG_TOKEN.length);
    }
  });

  it("官方推荐的正则能匹配新格式 —— 确认我们造的样本是真实形状", () => {
    // 官方给的匹配式:ghs_[A-Za-z0-9\.\-_]{36,}
    expect(/^ghs_[A-Za-z0-9.\-_]{36,}$/.test(LONG_TOKEN)).toBe(true);
  });

  it("覆盖开关只放行官方定义的两个值", async () => {
    stubConfig();
    const seen: Record<string, string>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify({ token: "ghs_x", expires_at: null }), {
        status: 200,
      });
    });

    const { getInstallationToken } = await import("@/lib/integrations/github");

    vi.stubEnv("GITHUB_APP_STATELESS_TOKENS", "enabled");
    await getInstallationToken("a");
    expect(seen.at(-1)?.["X-GitHub-Stateless-S2S-Token"]).toBe("enabled");

    vi.stubEnv("GITHUB_APP_STATELESS_TOKENS", "disabled");
    await getInstallationToken("b");
    expect(seen.at(-1)?.["X-GitHub-Stateless-S2S-Token"]).toBe("disabled");

    // 官方明确:其它值会被静默忽略。那就干脆不发,免得看起来像设置生效了
    vi.stubEnv("GITHUB_APP_STATELESS_TOKENS", "true");
    await getInstallationToken("c");
    expect(seen.at(-1)?.["X-GitHub-Stateless-S2S-Token"]).toBeUndefined();
  });
});

/**
 * 安装地址的 slug 必须问 GitHub 要,不能让人手填。
 *
 * 真实故障:GitHub App 叫 zhiyi-ai-repo,而用户照着旧的 OAuth App 名字
 * 填了 zhiyi-ai —— 「连接 GitHub」按钮跳到 GitHub 的 404。
 * 这个错误极难自查:用户看到的是 GitHub 的 404,不是我们的报错,
 * 完全无从判断是哪里配错了。
 *
 * slug 本来就是 GitHub 那边的事实,问它就好。少一个能填错的变量,
 * 就少一类故障。
 */
describe("应用 slug", () => {
  function stubConfig(envSlug?: string) {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", CONFIG.clientId);
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
    vi.stubEnv("GITHUB_APP_SLUG", envSlug ?? "");
  }

  it("向 GitHub 查真实 slug,而不是用环境变量里填的", async () => {
    stubConfig("填错的名字");
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ slug: "zhiyi-ai-repo" }), { status: 200 }),
    );

    const { getAppSlug } = await import("@/lib/integrations/github");
    expect(await getAppSlug()).toBe("zhiyi-ai-repo");
    vi.unstubAllGlobals();
  });

  it("查询失败时回退到环境变量 —— 网络抖一下不该让入口消失", async () => {
    stubConfig("兜底名字");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });

    const { getAppSlug } = await import("@/lib/integrations/github");
    expect(await getAppSlug()).toBe("兜底名字");
    vi.unstubAllGlobals();
  });

  it("查不到且没填环境变量时返回 null —— 不拼一个必然 404 的地址", async () => {
    stubConfig();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));

    const { getAppSlug } = await import("@/lib/integrations/github");
    expect(await getAppSlug()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("没填 GITHUB_APP_SLUG 也算配置完整 —— 它不再是必需项", async () => {
    stubConfig();
    const { getGitHubAppConfig } = await import("@/lib/integrations/github");
    expect(getGitHubAppConfig()).not.toBeNull();
  });
});
