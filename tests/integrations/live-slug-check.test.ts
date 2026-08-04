import { describe, expect, it, vi } from "vitest";

/**
 * 对着**真实 GitHub** 验证连接这条路走不走得通。
 *
 * 前面几轮全是用 mock 验证的,证明的是「逻辑正确」而不是「线上真的好了」——
 * 用户已经因此反复看到一个不工作的页面。这一组直接打真实网络:
 * 查证真实存在的应用名、生成安装地址、确认那个地址可达。
 *
 * 跑真实网络的测试有代价(慢、依赖外网),所以只留最关键的三条,
 * 而且不需要任何凭据 —— GitHub App 的公开页本来就免鉴权。
 */

vi.mock("server-only", () => ({}));

async function load() {
  vi.resetModules();
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.dummy");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "dummy");
  return import("@/lib/integrations/github");
}

describe("真实网络:应用名查证", () => {
  it("真实存在的应用名查证通过", async () => {
    const { verifyAppSlug } = await load();
    expect(await verifyAppSlug("zhiyi-ai-repo")).toBe(true);
  }, 30_000);

  it("不存在的应用名被拒 —— 这正是之前跳 404 的那个值", async () => {
    const { verifyAppSlug } = await load();
    // zhiyi-ai 是 OAuth App 的名字,不是 GitHub App 的
    expect(await verifyAppSlug("zhiyi-ai")).toBe(false);
  }, 30_000);

  it("生成的安装地址在 GitHub 上真的可达", async () => {
    const { installUrl } = await load();
    const url = installUrl("zhiyi-ai-repo", "STATE123");

    // 形状必须与官方文档一致:
    // https://github.com/apps/<slug>/installations/new?state=...
    expect(url).toBe(
      "https://github.com/apps/zhiyi-ai-repo/installations/new?state=STATE123",
    );

    // 而且真的打得开(未登录会被引到登录页,那也是 200 —— 关键是不能 404)
    const res = await fetch(url, { redirect: "follow" });
    expect(res.status).toBe(200);
    expect(res.url).not.toContain("/404");
  }, 30_000);
});
