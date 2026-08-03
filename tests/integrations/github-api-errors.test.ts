import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 诊断必须指对方向。
 *
 * 两个真实缺陷:
 *
 * N8 —— 创建分支失败时一律回「分支已存在,请换个名字」。GitHub 对已存在的
 *       引用返回 422,但 403(没有写权限)、404(仓库不存在)也会走进同一条
 *       分支。用户会一直换名字,而真正的原因(App 权限里没勾 Contents 写权限)
 *       一个字都没提到。
 *
 * N9 —— api() 把 JSON.parse 放在和网络错误同一个 try 里。GitHub 返回非 JSON
 *       (网关的 HTML 错误页、502 纯文本)时,解析异常掉进「无法连接 GitHub」——
 *       而请求其实完整收到了响应,只是内容不是 JSON。把「连不上」和
 *       「回的东西看不懂」混为一谈,会让人一直去查网络。
 *
 * 指错方向的诊断比不给诊断更浪费时间。
 */

vi.mock("server-only", () => ({}));

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.x");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
  vi.stubEnv("GITHUB_APP_SLUG", "zhiyi-ai");
});

/** 依次返回预设响应,模拟 commitFiles 的多步调用 */
function sequence(responses: readonly Response[]) {
  let i = 0;
  vi.stubGlobal("fetch", async () => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return r.clone();
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 换取安装令牌 + 取基线 ref + 取基线 commit + 建树 + 建 commit,共 5 步 */
function upToRefCreation(finalRefResponse: Response): readonly Response[] {
  return [
    json(200, { token: "ghs_x", expires_at: new Date(Date.now() + 3.6e6).toISOString() }),
    json(200, { object: { sha: "base" } }),
    json(200, { tree: { sha: "tree0" } }),
    json(200, { sha: "tree1" }),
    json(200, { sha: "commit1" }),
    finalRefResponse,
  ];
}

const REF = { owner: "me", repo: "app" };
const OPTS = {
  branch: "zhiyi/x",
  baseBranch: "main",
  message: "m",
  files: [{ path: "a.ts", content: "x" }],
};

describe("创建分支失败的诊断", () => {
  it("422 才说「分支已存在」", async () => {
    sequence(upToRefCreation(json(422, { message: "Reference already exists" })));
    const { commitFiles } = await import("@/lib/integrations/github");
    const r = await commitFiles("1", REF, OPTS);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("已存在");
  });

  it("403 说的是权限,并指向 Contents 写权限 —— 不能让人一直换分支名", async () => {
    sequence(upToRefCreation(json(403, { message: "Resource not accessible" })));
    const { commitFiles } = await import("@/lib/integrations/github");
    const r = await commitFiles("1", REF, OPTS);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("权限");
      expect(r.error).toContain("Read and write");
      expect(r.error).not.toContain("已存在");
    }
  });

  it("其它状态码如实报出,不冒充成已存在", async () => {
    sequence(upToRefCreation(json(404, { message: "Not Found" })));
    const { commitFiles } = await import("@/lib/integrations/github");
    const r = await commitFiles("1", REF, OPTS);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("创建分支失败");
      expect(r.error).not.toContain("已存在");
    }
  });
});

describe("非 JSON 响应", () => {
  it("不报成「无法连接」—— 请求明明成功收到了响应", async () => {
    sequence([
      json(200, { token: "ghs_x", expires_at: new Date(Date.now() + 3.6e6).toISOString() }),
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    ]);
    const { listRepoFiles } = await import("@/lib/integrations/github");
    const r = await listRepoFiles("1", REF, "");

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("502");
      // 关键:不能把「回的东西看不懂」说成「连不上」
      expect(r.error).not.toContain("无法连接");
    }
  });

  it("真正的网络故障仍然报「无法连接」", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const { getInstallationToken } = await import("@/lib/integrations/github");
    const r = await getInstallationToken("1");

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("无法连接");
  });
});
