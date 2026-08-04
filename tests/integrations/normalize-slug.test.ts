import { describe, expect, it, vi } from "vitest";

// github.ts 带 server-only 标记,测试环境里要先中和掉 ——
// 和 tests/integrations/github-jwt.test.ts 同一处理
vi.mock("server-only", () => ({}));

const { normalizeSlug } = await import("@/lib/integrations/github");

/**
 * 用户把 GITHUB_APP_SLUG 填成了
 *   https://github.com/settings/apps/zhiyi-ai-repo
 * 并且确信自己填对了。
 *
 * 他没错到哪去:那正是 GitHub App 设置页的地址,从地址栏复制是最自然的
 * 动作,而那个页面上没有任何地方单独把「名字」这三个字标出来给人抄。
 *
 * 此前只做了 trim,于是拿整条网址去拼安装地址,拼出一个不存在的东西,
 * 报错说「这个应用在 GitHub 上不存在」—— 一句把人往错误方向带的话,
 * 他照着核对了好几轮。**用户按最自然的方式操作却失败,是设计的问题。**
 */
describe("认得出用户实际会粘进来的东西", () => {
  const 认得出: ReadonlyArray<readonly [string, string]> = [
    ["zhiyi-ai-repo", "纯名字"],
    ["  zhiyi-ai-repo  ", "前后有空格(Vercel 输入框极易带上)"],
    ["github.com/apps/zhiyi-ai-repo", "不带协议的应用主页"],
    ["https://github.com/apps/zhiyi-ai-repo", "应用主页"],
    ["https://github.com/apps/zhiyi-ai-repo/installations/new", "安装地址"],
    [
      "https://github.com/settings/apps/zhiyi-ai-repo",
      "设置页 —— 用户实际填的就是这个",
    ],
    [
      "https://github.com/settings/apps/zhiyi-ai-repo/installations",
      "设置页的子页",
    ],
    ["https://github.com/apps/zhiyi-ai-repo/", "结尾多一个斜杠"],
  ];

  for (const [输入, 说明] of 认得出) {
    it(`${说明}:${输入}`, () => {
      expect(normalizeSlug(输入)).toBe("zhiyi-ai-repo");
    });
  }
});

describe("认不出来就返回 null,不硬猜", () => {
  /**
   * 猜错的代价还是一个 404,而 404 正是这几轮反复出现的那个问题。
   * 返回 null 时 getAppSlug() 会走公开页查证那条路,反而更稳。
   */
  const 认不出 = [
    ["", "空串 —— Vercel 上建了变量没填值就是这个"],
    ["   ", "只有空格"],
    [undefined, "变量没设"],
    [null, "显式为 null"],
    ["https://github.com/stbility/zhiyi-ai", "仓库地址,不是应用地址"],
    ["https://example.com/apps/../../etc/passwd", "路径穿越"],
    ["zhiyi ai repo", "带空格,不是合法 slug"],
    ["zhiyi_ai_repo", "下划线不是 GitHub 的 slug 字符"],
  ] as const;

  for (const [输入, 说明] of 认不出) {
    it(`${说明}`, () => {
      expect(normalizeSlug(输入)).toBeNull();
    });
  }

  it("超长输入不会被当成 slug", () => {
    expect(normalizeSlug(`https://github.com/apps/${"a".repeat(5000)}`)).toBe(
      "a".repeat(5000),
    );
    // 长度本身合法(全是合法字符),真正的把关在 verifyAppSlug ——
    // 它会去公开页查证,不存在就是不存在。这里不重复造一套长度规则:
    // 两处规则迟早分叉,而 GitHub 那边的事实只有一个。
  });
});
