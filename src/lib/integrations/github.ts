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

/**
 * 安装令牌新格式的按请求开关。
 *
 * GitHub 从 2026-04-27 起分批把安装令牌换成无状态格式 ghs_APPID_JWT,
 * 长度涨到约 520 字符,而且会随内容浮动。官方明确警告:
 * 「Apps with hardcoded length assumptions may break」。
 *
 * 我们这边没有任何长度或前缀假设 —— 令牌只是原样存进内存缓存再原样发出去,
 * 唯一的 slice(0, 300) 是截断**错误响应体**用的,和令牌无关。
 * 所以理论上不受影响。
 *
 * 但「理论上不受影响」不等于验证过。官方提供了按请求覆盖的头,
 * 可以在正式推到我们之前先用新格式实测一遍;万一真出问题,
 * 也能临时切回旧格式争取修复时间。
 *
 *   enabled  —— 强制返回新的无状态令牌(用来提前验证)
 *   disabled —— 强制返回旧的不透明令牌(出问题时的退路)
 *   不设置    —— 跟随官方灰度节奏
 *
 * 其它值会被 GitHub 静默忽略,所以这里只放行这两个,写错了当没设。
 *
 * 来源:https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/
 */
function statelessTokenHeader(): Record<string, string> {
  const mode = process.env["GITHUB_APP_STATELESS_TOKENS"];
  if (mode !== "enabled" && mode !== "disabled") return {};
  return { "X-GitHub-Stateless-S2S-Token": mode };
}

export interface GitHubAppConfig {
  readonly clientId: string;
  readonly privateKey: string;
  /**
   * 安装页用的 slug。
   *
   * 可以不填 —— 填了只当兜底。真实值由 getAppSlug() 向 GitHub 查询。
   *
   * 为什么不让用户填:填错的代价是「连接 GitHub」按钮跳到一个 404 页面,
   * 而这个错误极难自查 —— 用户看到的是 GitHub 的 404,不是我们的报错,
   * 完全无从判断是哪里配错了。实际发生过:GitHub App 叫 zhiyi-ai-repo,
   * 而用户照着旧的 OAuth App 名字填了 zhiyi-ai。
   * slug 本来就是 GitHub 那边的事实,问它就好,不该让人手抄一遍。
   */
  readonly slug: string | null;
}

/**
 * 读取 App 配置。未配置时返回 null —— 由调用方如实显示「未配置」,
 * 绝不伪装成已接通。
 */
export function getGitHubAppConfig(): GitHubAppConfig | null {
  const clientId = process.env["GITHUB_APP_CLIENT_ID"];
  const rawKey = process.env["GITHUB_APP_PRIVATE_KEY"];
  // slug 不再是必需项 —— 它由 getAppSlug() 向 GitHub 查询。
  //
  // 这里不能用 ??:环境变量存在但为空串时(在 Vercel 上很常见 ——
  // 建了变量没填值就是空串),?? 不会回退,于是拿到一个空 slug,
  // 拼出 https://github.com/apps//installations/new 这种必然 404 的地址。
  // 和 gateway 里 content ?? reasoning_content 是同一个陷阱:
  // 判空要按「有没有值」判,不是按「是不是 null」判。
  const slug = process.env["GITHUB_APP_SLUG"] || null;
  if (!clientId || !rawKey) return null;

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
        "尚未配置 GitHub App(缺少 GITHUB_APP_CLIENT_ID 或 GITHUB_APP_PRIVATE_KEY)。",
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
        headers: { ...headers(jwt), ...statelessTokenHeader() },
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

/**
 * 应用 slug 的缓存。只缓存**向 GitHub 查证过**的值。
 *
 * 它几乎不变(改名才会变),而每次渲染集成页都要用它拼安装地址。
 */
let cachedSlug: string | null = null;

export interface AppSlugResult {
  readonly slug: string | null;
  /** github = 向 GitHub 查证过;env = 只是环境变量里填的,未经查证 */
  readonly source: "github" | "env" | "none";
  /** 查证失败时的原因,要显示给用户 —— 这是他唯一能据以排查的线索 */
  readonly error: string | null;
}

/**
 * 取这个 App 的 slug,并如实说明来源是否可信。
 *
 * 安装页地址是 https://github.com/apps/<slug>/installations/new,
 * slug 错了就是 GitHub 的 404 —— 用户看到的不是我们的报错,
 * 完全无从判断哪里配错了。
 *
 * 上一版这里有个自相矛盾:查询失败时静默回退到环境变量,而那个值**未经验证**。
 * 一边写着「不生成必然 404 的地址」,一边把一个没验过的值拿去拼地址 ——
 * 实际发生的正是这样:GitHub App 叫 zhiyi-ai-repo,环境变量填的是旧
 * OAuth App 的名字 zhiyi-ai,查询失败后照样拼出 404 链接,
 * 而用户看到的仍然只是一个 GitHub 404。
 *
 * 现在把来源一并返回:回退值仍然给(总比什么都没有强),但**必须标明
 * 它未经查证**,并把 GitHub 的原始报错带出来。查证失败最常见的原因是
 * GITHUB_APP_CLIENT_ID 填成了 OAuth App 的 client id —— 那会得到 401,
 * 说出来用户三十秒就能改对;不说,他只能一直盯着一个 404 页面。
 *
 * GET /app 用 App JWT 认证,返回里就有 slug。
 * 来源:https://docs.github.com/en/rest/apps/apps
 */
export async function getAppSlug(): Promise<AppSlugResult> {
  if (cachedSlug) {
    return { slug: cachedSlug, source: "github", error: null };
  }

  const config = getGitHubAppConfig();
  if (!config) {
    return { slug: null, source: "none", error: "尚未配置 GitHub App。" };
  }

  let failure: string;
  try {
    const response = await fetch(`${API}/app`, {
      headers: headers(signAppJwt(config)),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      const payload = (await response.json()) as { slug?: string };
      if (payload.slug) {
        cachedSlug = payload.slug;
        return { slug: payload.slug, source: "github", error: null };
      }
      failure = "GitHub 返回的应用信息里没有 slug。";
    } else if (response.status === 401) {
      // 这是最常见的一种配错,直接把话说到位
      failure =
        "GitHub 拒绝了应用凭据(401)。最常见的原因是 GITHUB_APP_CLIENT_ID " +
        "填成了 OAuth App 的 client id,或私钥与这个 App 不匹配 —— " +
        "请到 GitHub App(不是 OAuth App)的设置页核对 Client ID 与私钥。";
    } else {
      failure = `向 GitHub 查询应用信息失败(HTTP ${response.status})${await readError(response)}`;
    }
  } catch (e) {
    failure =
      e instanceof Error && e.name === "TimeoutError"
        ? "向 GitHub 查询应用信息超时(10 秒)。"
        : "无法连接 GitHub。";
  }

  logger.warn({ failure }, "查询 App slug 失败");

  // 回退值仍然给,但明确标注未经查证 —— 让界面能把这件事告诉用户
  return {
    slug: config.slug,
    source: config.slug ? "env" : "none",
    error: failure,
  };
}

export interface InstallationInfo {
  /** 装在谁名下,纯展示用 —— 让用户认得出连的是哪个账号 */
  readonly accountLogin: string | null;
  /** all 或 selected。用户在 GitHub 界面上选的范围 */
  readonly repositorySelection: string | null;
}

/**
 * 读取安装的详情。
 *
 * 上一版把 account_login 建了列却从没写入,repository_selection 存的是
 * URL 里的 setup_action —— 那个值是 "install" / "update",表示这次动作
 * 是安装还是更新,和「授权了哪些仓库」完全无关。库里存着字段名与内容
 * 对不上的数据,比不存更糟:后来的人会照着字段名去用它。
 *
 * 真实数据只能问 GitHub 要。
 */
export async function getInstallation(
  installationId: string,
): Promise<InstallationInfo> {
  const config = getGitHubAppConfig();
  if (!config) return { accountLogin: null, repositorySelection: null };

  try {
    const jwt = signAppJwt(config);
    const response = await fetch(
      `${API}/app/installations/${encodeURIComponent(installationId)}`,
      { headers: headers(jwt), signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) return { accountLogin: null, repositorySelection: null };

    const payload = (await response.json()) as {
      account?: { login?: string };
      repository_selection?: string;
    };
    return {
      accountLogin: payload.account?.login ?? null,
      repositorySelection: payload.repository_selection ?? null,
    };
  } catch {
    // 取不到不影响连接本身 —— 这两个字段只是展示用
    return { accountLogin: null, repositorySelection: null };
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

  // 必须翻页。
  //
  // 上一版只取 ?per_page=100 的第一页就返回,授权超过 100 个仓库时
  // 后面的会被**静默丢掉** —— 用户在 GitHub 上明明勾了,系统里却说
  // 「不在授权范围内」,而且没有任何迹象表明是被截断了。
  // 白名单少一个仓库不是小事:它直接决定智能体能不能碰那个项目。
  const repos: RepoSummary[] = [];
  const MAX_PAGES = 20; // 2000 个仓库,足够;同时防止分页出错时无限循环

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await fetch(
        `${API}/installation/repositories?per_page=100&page=${page}`,
        { headers: headers(auth.token), signal: AbortSignal.timeout(15_000) },
      );
      if (!response.ok) {
        return {
          ok: false,
          error: `读取仓库列表失败(HTTP ${response.status})${await readError(response)}`,
        };
      }

      const payload = (await response.json()) as {
        total_count?: number;
        repositories?: {
          full_name?: string;
          default_branch?: string;
          private?: boolean;
        }[];
      };

      const batch = payload.repositories ?? [];
      for (const r of batch) {
        if (!r.full_name) continue;
        repos.push({
          fullName: r.full_name,
          defaultBranch: r.default_branch ?? "main",
          private: r.private ?? true,
        });
      }

      // 取满一页说明可能还有下一页;不满就到头了
      if (batch.length < 100) break;
    }

    return { ok: true, repos };
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


// ---------------------------------------------------------------------------
// 仓库读写
//
// 只用 REST 的 Contents / Git Data API,不做本地 clone ——
// 无服务器函数没有可持久化的磁盘,而且一个大仓库 clone 下来就撞上
// 300 秒的函数时限了。按需读单个文件、按需提交,才是这个运行环境里
// 能真正跑通的做法。
// ---------------------------------------------------------------------------

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
  readonly ref?: string | undefined;
}

/** 把 "owner/repo" 拆开。格式不对时如实返回 null,不猜 */
export function parseRepo(fullName: string): { owner: string; repo: string } | null {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

interface Fetched {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
  readonly error: string;
}

async function api(
  installationId: string,
  path: string,
  init: RequestInit = {},
): Promise<Fetched> {
  const auth = await getInstallationToken(installationId);
  if (!auth.ok) {
    return { ok: false, status: 0, body: null, error: auth.error };
  }

  try {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...headers(auth.token), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });

    const text = await response.text();

    // JSON 解析要单独兜住,不能和网络错误共用一个 catch。
    //
    // 上一版把 JSON.parse 放在外层 try 里:GitHub 返回非 JSON(网关的
    // HTML 错误页、502 的纯文本、空体的 204)时,解析异常会掉进
    // 「无法连接 GitHub」那个分支 —— 而请求其实完整地收到了响应,
    // 只是内容不是 JSON。把「连不上」和「回的东西看不懂」混为一谈,
    // 会让人一直去查网络。
    let body: unknown = null;
    let parseFailed = false;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        parseFailed = true;
      }
    }

    if (!response.ok) {
      const message = (body as { message?: string } | null)?.message;
      return {
        ok: false,
        status: response.status,
        body,
        error:
          `GitHub 返回 HTTP ${response.status}` +
          (message
            ? `:${message}`
            : parseFailed
              ? `(响应不是 JSON:${text.slice(0, 120)})`
              : ""),
      };
    }

    if (parseFailed) {
      return {
        ok: false,
        status: response.status,
        body: null,
        error: `GitHub 返回了 HTTP ${response.status},但响应不是合法的 JSON。`,
      };
    }

    return { ok: true, status: response.status, body, error: "" };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      error:
        e instanceof Error && e.name === "TimeoutError"
          ? "GitHub 请求超时(20 秒)。"
          : "无法连接 GitHub。",
    };
  }
}

export interface RepoFile {
  readonly path: string;
  readonly content: string;
  /** 覆盖写时必须带上,GitHub 用它做乐观锁 */
  readonly sha: string;
}

/**
 * 读一个文件。
 *
 * 目录、二进制、超大文件都会如实拒绝而不是返回一堆乱码 ——
 * 让模型看到 base64 噪音只会让它据此编造内容。
 */
export async function readRepoFile(
  installationId: string,
  ref: RepoRef,
  path: string,
): Promise<{ ok: true; file: RepoFile } | { ok: false; error: string }> {
  const query = ref.ref ? `?ref=${encodeURIComponent(ref.ref)}` : "";
  const r = await api(
    installationId,
    `/repos/${ref.owner}/${ref.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${query}`,
  );

  if (!r.ok) {
    if (r.status === 404) return { ok: false, error: `仓库里没有 ${path}。` };
    return { ok: false, error: r.error };
  }

  const payload = r.body as {
    type?: string;
    encoding?: string;
    content?: string;
    sha?: string;
  };

  if (Array.isArray(r.body)) {
    return { ok: false, error: `${path} 是一个目录,不是文件。` };
  }
  if (payload.type !== "file" || !payload.sha) {
    return { ok: false, error: `${path} 不是普通文件。` };
  }
  // 超过 1MB 时 GitHub 不返回内容,只给元数据 —— 必须如实说明
  if (payload.encoding !== "base64" || payload.content === undefined) {
    return {
      ok: false,
      error: `${path} 太大或不是文本文件,无法通过接口读取内容。`,
    };
  }

  return {
    ok: true,
    file: {
      path,
      content: Buffer.from(payload.content, "base64").toString("utf8"),
      sha: payload.sha,
    },
  };
}

/** 列出某个目录下的条目 —— 让模型先看清结构,而不是凭猜去读文件 */
export async function listRepoFiles(
  installationId: string,
  ref: RepoRef,
  path = "",
): Promise<
  | { ok: true; entries: { path: string; type: "file" | "dir"; size: number }[] }
  | { ok: false; error: string }
> {
  const query = ref.ref ? `?ref=${encodeURIComponent(ref.ref)}` : "";
  const r = await api(
    installationId,
    `/repos/${ref.owner}/${ref.repo}/contents/${path}${query}`,
  );
  if (!r.ok) return { ok: false, error: r.error };

  const rows = Array.isArray(r.body) ? r.body : [r.body];
  return {
    ok: true,
    entries: (rows as { path?: string; type?: string; size?: number }[]).flatMap(
      (e) =>
        e.path
          ? [
              {
                path: e.path,
                type: e.type === "dir" ? ("dir" as const) : ("file" as const),
                size: e.size ?? 0,
              },
            ]
          : [],
    ),
  };
}


/**
 * 提交一批文件到指定分支。
 *
 * **不允许直接写默认分支** —— 这是硬规则,不是可配置项。
 *
 * 理由很实际:模型会犯错,而且它犯的错往往看起来很合理。让它直接推
 * main 意味着一次误判就能覆盖用户的代码,而且没有中间环节可以拦。
 * 走分支 + PR 之后,用户在合并前一定会看到 diff —— 那道人工确认
 * 是整条链路里唯一不能省的一环。
 *
 * 用 Git Data API 手工造树而不是逐个调 Contents API:
 * 后者每个文件一次提交,改 5 个文件就是 5 个提交、5 个往返,
 * 而且中途失败会留下半吊子状态。造一棵树一次提交是原子的。
 */
export async function commitFiles(
  installationId: string,
  ref: RepoRef,
  options: {
    branch: string;
    baseBranch: string;
    message: string;
    files: readonly { path: string; content: string }[];
  },
): Promise<{ ok: true; commitSha: string } | { ok: false; error: string }> {
  const { owner, repo } = ref;
  if (options.files.length === 0) {
    return { ok: false, error: "没有要提交的文件。" };
  }

  // 1. 取基线分支的最新提交
  const baseRef = await api(
    installationId,
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(options.baseBranch)}`,
  );
  if (!baseRef.ok) {
    return { ok: false, error: `读取基线分支失败:${baseRef.error}` };
  }
  const baseSha = (baseRef.body as { object?: { sha?: string } }).object?.sha;
  if (!baseSha) return { ok: false, error: "基线分支没有提交。" };

  // 2. 取基线提交的树
  const baseCommit = await api(
    installationId,
    `/repos/${owner}/${repo}/git/commits/${baseSha}`,
  );
  if (!baseCommit.ok) return { ok: false, error: baseCommit.error };
  const baseTree = (baseCommit.body as { tree?: { sha?: string } }).tree?.sha;
  if (!baseTree) return { ok: false, error: "读取基线树失败。" };

  // 3. 造一棵新树。content 直接内联,GitHub 会自动建 blob
  const tree = await api(installationId, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseTree,
      tree: options.files.map((f) => ({
        path: f.path,
        mode: "100644",
        type: "blob",
        content: f.content,
      })),
    }),
  });
  if (!tree.ok) return { ok: false, error: `创建文件树失败:${tree.error}` };
  const treeSha = (tree.body as { sha?: string }).sha;
  if (!treeSha) return { ok: false, error: "创建文件树失败。" };

  // 4. 造提交
  const commit = await api(installationId, `/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: options.message,
      tree: treeSha,
      parents: [baseSha],
    }),
  });
  if (!commit.ok) return { ok: false, error: `创建提交失败:${commit.error}` };
  const commitSha = (commit.body as { sha?: string }).sha;
  if (!commitSha) return { ok: false, error: "创建提交失败。" };

  // 5. 指向新提交。分支不存在就建,存在就快进
  const created = await api(installationId, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${options.branch}`,
      sha: commitSha,
    }),
  });

  if (!created.ok) {
    // 分支已存在时**直接拒绝**,不去快进它。
    //
    // 上一版这里改成 PATCH ... force:false,想的是「别让整次工作白做」。
    // 但那样会破掉这条链路的核心承诺:改动一律以 PR 的形式交给用户审阅。
    // 如果模型挑中的是一个已有分支(staging、release、某个同事正在用的
    // 特性分支),而它恰好还没和默认分支分叉,快进就会成功 ——
    // 改动直接落到了用户的已有分支上,PR 是事后才开的,中间没有任何
    // 人工确认的机会。默认分支被挡住了,其它分支却从这里漏了过去。
    //
    // 所以:分支必须由本次创建。撞名了就换一个,那点重试成本远小于
    // 「悄悄改了用户正在用的分支」。
    // 但要区分「分支已存在」和「别的失败」。
    //
    // GitHub 对已存在的引用返回 422;403 是权限不足、404 是仓库不存在或
    // 没授权。上一版不看状态码,一律回「分支已存在,请换个名字」——
    // 用户会一直换名字,而真正的原因(比如 App 权限里没勾 Contents 写权限)
    // 一个字都没提到。诊断指错方向比不给诊断更浪费时间。
    if (created.status === 422) {
      return {
        ok: false,
        error:
          `分支 ${options.branch} 已存在。为避免改动落到别人正在用的分支上,` +
          `每次提交都必须使用新分支 —— 请换一个分支名重试。`,
      };
    }
    if (created.status === 403) {
      return {
        ok: false,
        error:
          `没有写入 ${owner}/${repo} 的权限(HTTP 403)。` +
          `请到 GitHub 的应用设置里确认 Contents 权限为 Read and write,` +
          `并且这个仓库在授权范围内${created.error ? `。${created.error}` : ""}`,
      };
    }
    return { ok: false, error: `创建分支失败:${created.error}` };
  }

  return { ok: true, commitSha };
}

export interface PullRequestResult {
  readonly number: number;
  readonly url: string;
}

/** 开一个 PR。合并与否永远由人决定 —— 我们只负责把改动摆到台面上 */
export async function openPullRequest(
  installationId: string,
  ref: RepoRef,
  options: { head: string; base: string; title: string; body: string },
): Promise<{ ok: true; pr: PullRequestResult } | { ok: false; error: string }> {
  const r = await api(installationId, `/repos/${ref.owner}/${ref.repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: options.title,
      body: options.body,
      head: options.head,
      base: options.base,
    }),
  });

  if (!r.ok) return { ok: false, error: `创建 PR 失败:${r.error}` };

  const payload = r.body as { number?: number; html_url?: string };
  if (!payload.number || !payload.html_url) {
    return { ok: false, error: "GitHub 未返回 PR 信息。" };
  }
  return { ok: true, pr: { number: payload.number, url: payload.html_url } };
}
