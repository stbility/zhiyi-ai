import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * 匿名请求不该跨洋鉴权。
 *
 * 起因是真实的性能问题:Supabase 在新加坡,Vercel 函数原本在华盛顿,
 * 而 proxy 对**每一个**请求都跑一次 getUser()。匿名访客打开首页时,
 * 这次往返的结果必然是 null —— 没有会话 Cookie 就不可能有会话。
 * 为一个已知答案跨太平洋跑一趟,是纯粹的延迟浪费。
 *
 * 但这条捷径落在鉴权路径上,必须证明它只放宽了性能、没有放宽安全:
 * 没有 Cookie 的请求访问受保护路由,仍然要被挡回登录页。
 */

const getUser = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));

/** 造一个最小的 NextRequest 替身,只提供 proxy 用到的部分 */
function request(path: string, cookies: readonly string[]) {
  const url = new URL(`https://zhiyi-ai.vercel.app${path}`);
  return {
    nextUrl: Object.assign(url, { clone: () => new URL(url.toString()) }),
    url: url.toString(),
    headers: new Headers({ host: "zhiyi-ai.vercel.app" }),
    cookies: {
      getAll: () => cookies.map((name) => ({ name, value: "x" })),
      set: () => {},
      delete: () => {},
    },
  } as never;
}

const SESSION_COOKIE = "sb-ullmdnbgtauupndwqqzd-auth-token";

beforeEach(() => {
  getUser.mockReset();
  getUser.mockResolvedValue({ data: { user: null }, error: null });
  process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://example.supabase.co";
  process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = "anon-key";
});

describe("匿名请求的鉴权捷径", () => {
  it("没有会话 Cookie 时不发起 getUser 网络校验", async () => {
    const { proxy } = await import("@/proxy");
    await proxy(request("/", []));
    expect(getUser).not.toHaveBeenCalled();
  });

  it("没有会话 Cookie 访问受保护路由,仍然挡回登录页", async () => {
    // 这是这条捷径的安全底线:省掉的只是网络往返,不是那道门
    const { proxy } = await import("@/proxy");
    const res = await proxy(request("/assistant", []));
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
    // 登录后要能回到原本要去的地方
    expect(location).toContain("next=%2Fassistant");
    expect(getUser).not.toHaveBeenCalled();
  });

  it("带着会话 Cookie 时照常校验 —— 伪造的 Cookie 过不了这一关", async () => {
    const { proxy } = await import("@/proxy");
    await proxy(request("/assistant", [SESSION_COOKIE]));
    expect(getUser).toHaveBeenCalledTimes(1);
  });
});
