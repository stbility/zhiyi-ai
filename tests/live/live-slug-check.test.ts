import { describe, expect, it, vi } from "vitest";

/**
 * 对着**真实 GitHub** 验证连接这条路走不走得通 —— 真实网络冒烟。
 *
 * 前面几轮全是用 mock 验证的,证明的是「逻辑正确」而不是「线上真的好了」——
 * 用户已经因此反复看到一个不工作的页面。这一组直接打真实网络:
 * 查证真实存在的应用名、生成安装地址、确认那个地址可达。
 *
 * 【为什么单独一个目录,不进主门禁】
 * 它打的是真实 GitHub,而 CI 共享出口 IP 上 github.com 偶发超时
 * (2026-08-07 实测:同一 commit 两次 CI 一红一绿,红的唯一原因是一次
 * HEAD 超时)。主门禁(pnpm verify)必须**确定性** —— 网络抖动不该决定
 * 代码能不能合并,否则每次红灯都要人去分辨「是代码坏了还是网络抖了」。
 *
 * 因此:
 *   · 本文件由 vitest.config.ts 的 exclude 排除出 pnpm test / pnpm verify
 *   · 单独跑:`pnpm test:live`(package.json),CI 里是独立 job「真实网络冒烟」
 *   · **不重试、不掩盖**:单次调用,失败即红。GitHub 持续不可达时它必须红,
 *     那是真实信号。之前一度在断言里循环重试 3 次 —— 那是把「总有一次会过」
 *     当稳定性,掩盖了「线上可能已经断了」,已回退。
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
