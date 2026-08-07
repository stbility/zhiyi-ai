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
 *
 * 【为什么有重试】2026-08-07 实测:同一 commit 的两次 CI 一红一绿,
 * 红的唯一原因是 github.com 偶发一次 HEAD 超时 —— CI 共享出口 IP 上
 * 这属于瞬态抖动,不是产品回归。重试只吸收瞬态:GitHub 长时间不可达时
 * 正向断言仍然会红,不会把「线上断了」掩盖成绿。
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
    // 8s 超时一次命中即 false;瞬态抖动由重试吸收,持续失败仍会红
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      ok = await verifyAppSlug("zhiyi-ai-repo");
      if (!ok && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    expect(ok).toBe(true);
  }, 45_000);

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
    // 与第一条同因:瞬态超时由重试吸收
    let status = 0;
    let finalUrl = "";
    for (let attempt = 1; attempt <= 3 && status !== 200; attempt++) {
      try {
        const res = await fetch(url, { redirect: "follow" });
        status = res.status;
        finalUrl = res.url;
      } catch {
        status = 0;
      }
      if (status !== 200 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    expect(status).toBe(200);
    expect(finalUrl).not.toContain("/404");
  }, 45_000);
});
