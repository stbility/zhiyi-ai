import "server-only";

import { createHmac, createSign } from "node:crypto";

import { logger } from "@/lib/log";

/**
 * GitHub App 接入。
 *
 * 为什么是 GitHub App 而不是 Personal Access Token:
 *   · 权限按仓库授予,用户在 GitHub 界面上勾选哪些仓库我们就只能碰哪些
 *   · 凭据是**短期**的(安装令牌活 1 小时),泄露的窗口小
 *   · 用户随时能在 GitHub 侧一键撤销,不必来我们这里删
 *   · 我们永远不持有用户的长期令牌 —— 只持有 App 私钥,那是我们自己的
 *
 * 认证链路(全部按官方文档,不凭经验):
 *   1. 用 App 私钥签一个 JWT(RS256),iss 用 Client ID,
 *      iat 往前 60 秒防时钟漂移,exp 不超过 10 分钟
 *   2. 拿 JWT 调 POST /app/installations/{id}/access_tokens 换安装令牌
 *   3. 安装令牌 1 小时过期,用它调普通 REST 接口
 *
 * 文档:
 *   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 *   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
 */

const API = "https://api.github.com";

/** 官方要求带上的版本头,不带的话行为随 GitHub 默认版本漂移 */
const API_VERSION = "2026-03-10";

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "zhiyi-ai",
  };
}

export interface GitHubAppConfig {
  readonly clientId: string;
  readonly privateKey: string;
  readonly slug: string;
}

/**
 * 读取 App 配置。未配置时返回 null —— 由调用方如实显示「未配置」,
 * 绝不伪装成已接通。
 */
export function getGitHubAppConfig(): GitHubAppConfig | null {
  const clientId = process.env["GITHUB_APP_CLIENT_ID"];
  const rawKey = process.env["GITHUB_APP_PRIVATE_KEY"];
  const slug = process.env["GITHUB_APP_SLUG"];
  if (!clientId || !rawKey || !slug) return null;

  // 环境变量里换行常被写成字面量 \n(Vercel 的输入框就是这样),
  // 不还原的话 PEM 解析会直接失败,而报错信息是「不是合法的私钥」——
  // 很容易被误判成密钥填错了。
  const privateKey = rawKey.includes("\\n")
    ? rawKey.replace(/\\n/g, "\n")
    : rawKey;

  return { clientId, privateKey, slug };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * 签一个 App JWT。
 *
 * 手写而不是引第三方 JWT 库:这里只需要 RS256 一种算法、三个固定声明,
 * node:crypto 直接就能做。多一个依赖就多一处供应链风险,而这条链路
 * 握着的是能访问用户仓库的私钥。
 */
export function signAppJwt(config: GitHubAppConfig, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    // 官方建议往前 60 秒,防止我们的时钟比 GitHub 快一点点导致 JWT 被判为「来自未来」
    iat: seconds - 60,
    // 官方硬上限是 10 分钟。取 9 分钟留一点余量,不贴着边界
    exp: seconds + 9 * 60,
    // 官方推荐用 Client ID 而不是 App ID
    iss: config.clientId,
  };

  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256")
    .update(data)
    .sign(config.privateKey);

  return `${data}.${base64url(signature)}`;
}

interface CachedToken {
  readonly token: string;
  /** 毫秒时间戳 */
  readonly expiresAt: number;
}

/**
 * 安装令牌缓存。
 *
 * 令牌活 1 小时,而一次智能体运行可能连续调十几次接口 —— 每次都去换一个
 * 是白白多十几个往返,还会撞上 GitHub 对换取接口本身的限流。
 *
 * 缓存在模块作用域:无服务器函数实例存活期间有效,实例回收就没了 ——
 * 这正合适。不该把它落库:令牌是短期凭据,存下来只会扩大泄露面。
 */
const tokenCache = new Map<string, CachedToken>();

/** 提前 5 分钟视为过期,避免「换到手就正好过期」的边界 */
const EXPIRY_MARGIN_MS = 5 * 60_000;

export async function getInstallationToken(
  installationId: string,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const config = getGitHubAppConfig();
  if (!config) {
    return {
      ok: false,
      error:
        "尚未配置 GitHub App(缺少 GITHUB_APP_CLIENT_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_SLUG)。",
    };
  }

  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return { ok: true, token: cached.token };
  }

  let jwt: string;
  try {
    jwt = signAppJwt(config);
  } catch (e) {
    // 私钥格式不对是最常见的配置错误,要说清楚是哪一步失败的,
    // 否则用户只会看到一句笼统的「连接失败」
    return {
      ok: false,
      error: `App 私钥无法用于签名,请检查 GITHUB_APP_PRIVATE_KEY 是否为完整的 PEM:${
        e instanceof Error ? e.message : "未知错误"
      }`,
    };
  }

  try {
    const response = await fetch(
      `${API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: "POST",
        headers: headers(jwt),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      const detail = await readError(response);
      logger.warn(
        { installationId, status: response.status, detail },
        "换取 GitHub 安装令牌失败",
      );
      if (response.status === 404) {
        return {
          ok: false,
          error:
            "找不到这个安装 —— 通常是用户已经在 GitHub 侧卸载了本应用。请重新连接。",
        };
      }
      return { ok: false, error: `换取安装令牌失败(HTTP ${response.status})${detail}` };
    }

    const payload = (await response.json()) as {
      token?: string;
      expires_at?: string;
    };
    if (!payload.token) {
      return { ok: false, error: "GitHub 未返回安装令牌。" };
    }

    const expiresAt = payload.expires_at
      ? Date.parse(payload.expires_at)
      : Date.now() + 60 * 60_000;
    tokenCache.set(installationId, { token: payload.token, expiresAt });

    return { ok: true, token: payload.token };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error && e.name === "TimeoutError"
          ? "连接 GitHub 超时(15 秒)。"
          : "无法连接 GitHub。",
    };
  }
}

/** 取上游错误原话,但绝不把响应体原样带出 —— 里面可能回显令牌 */
async function readError(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 300);
    const parsed = JSON.parse(text) as { message?: string };
    return parsed.message ? `:${parsed.message}` : "";
  } catch {
    return "";
  }
}

export interface RepoSummary {
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
}

/** 列出这次安装能访问的仓库 —— 用户在 GitHub 上勾了哪些,这里就只有哪些 */
export async function listRepositories(
  installationId: string,
): Promise<{ ok: true; repos: RepoSummary[] } | { ok: false; error: string }> {
  const auth = await getInstallationToken(installationId);
  if (!auth.ok) return auth;

  try {
    const response = await fetch(
      `${API}/installation/repositories?per_page=100`,
      { headers: headers(auth.token), signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) {
      return {
        ok: false,
        error: `读取仓库列表失败(HTTP ${response.status})${await readError(response)}`,
      };
    }

    const payload = (await response.json()) as {
      repositories?: {
        full_name?: string;
        default_branch?: string;
        private?: boolean;
      }[];
    };

    return {
      ok: true,
      repos: (payload.repositories ?? []).flatMap((r) =>
        r.full_name
          ? [
              {
                fullName: r.full_name,
                defaultBranch: r.default_branch ?? "main",
                private: r.private ?? true,
              },
            ]
          : [],
      ),
    };
  } catch {
    return { ok: false, error: "无法连接 GitHub。" };
  }
}

/**
 * 签发一个带组织标识的 state。
 *
 * 回调地址是公开的,任何人都能构造一个带 installation_id 的请求打过来。
 * 没有 state 的话,攻击者可以把**他自己的**安装绑到**你的**组织上 ——
 * 之后他的仓库出现在你的工作区里还算轻的,反过来他也能借你的组织
 * 读到你连的仓库。
 *
 * 用 App 私钥做 HMAC,不额外引入一把密钥 —— 私钥本来就只在服务端。
 * 带上签发时间,回调侧只认 15 分钟内的,避免旧链接被无限重放。
 */
export function issueState(organizationId: string, now = Date.now()): string {
  const config = getGitHubAppConfig();
  if (!config) throw new Error("尚未配置 GitHub App");

  const payload = Buffer.from(
    JSON.stringify({ organizationId, issuedAt: now }),
  ).toString("base64url");

  const signature = createHmac("sha256", config.privateKey)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

/** 安装页地址。用户点它去 GitHub 授权,选择要开放哪些仓库 */
export function installUrl(slug: string, state: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
}
