import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { normalizeInstallationId } = await import("@/lib/integrations/github");

/**
 * 真实事故:文档里的占位符写作 `installation_id=<数字>`,
 * 用户照着填时**把尖括号一起带上了** —— `?installation_id=<151228033>`。
 *
 * 这个值编码后是 %3C151228033%3E,换令牌必然失败。而从用户那一侧看
 * 一切正常:页面确实跳回来了、库里确实多了一行、卡片显示
 * 「已安装 · 凭据待修复」—— 于是排查方向被引向凭据,
 * 而真正坏的只是两个尖括号。
 *
 * **用户按最自然的方式操作却失败,是设计的问题。**
 * 占位符连着贴进去是完全可以预料的,系统该认得出来 ——
 * 就像 normalizeSlug 认得出用户粘的是整条网址一样。
 */
describe("认得出用户实际会贴进来的形态", () => {
  const 认得出: ReadonlyArray<readonly [string, string]> = [
    ["151228033", "纯数字"],
    ["<151228033>", "带占位符尖括号 —— 实际发生的那一种"],
    ['"151228033"', "带双引号"],
    ["'151228033'", "带单引号"],
    ["  151228033  ", "带空白"],
    ["<  151228033  >", "尖括号里还有空白"],
  ];

  for (const [输入, 说明] of 认得出) {
    it(`${说明}:${输入}`, () => {
      expect(normalizeInstallationId(输入)).toBe("151228033");
    });
  }
});

describe("不从杂字里凭空提取数字", () => {
  /**
   * 「提取」比失败更糟:把 abc123def 变成 123,等于拿一个凭空捏造的
   * 编号去调 GitHub。那个编号可能属于**别人的**安装。
   */
  const 认不出 = [
    ["abc123def", "混着字母 —— 提取出 123 会指向别人的安装"],
    ["151228033/repos", "带路径"],
    ["https://github.com/settings/installations/151228033", "整条网址"],
    ["", "空串"],
    ["   ", "只有空白"],
    [undefined, "没有这个参数"],
    [null, "显式为 null"],
    ["-151228033", "负数"],
    ["151228033.0", "小数"],
  ] as const;

  for (const [输入, 说明] of 认不出) {
    it(`${说明}`, () => {
      expect(normalizeInstallationId(输入)).toBeNull();
    });
  }
});

describe("回调把「填错了」和「什么都没带」分开说", () => {
  const CALLBACK = readFileSync(
    resolve(__dirname, "../../src/app/api/integrations/github/callback/route.ts"),
    "utf8",
  );

  it("有值但不合法时,直接指出尖括号", () => {
    // 混进「没带 installation_id」那一支的话,用户会去查 Setup URL 配置,
    // 而那边根本没问题 —— 又是一句把人往错误方向带的话
    expect(CALLBACK).toMatch(/rawInstallationId && !installationId/);
    expect(CALLBACK).toMatch(/把尖括号一起带上/);
  });

  it("落库的是规范化之后的值", () => {
    // 存进去带尖括号的话,以后每次调 GitHub 都会失败,
    // 而库里那行看起来完全正常
    expect(CALLBACK).toMatch(/installation_id: installationId/);
    expect(CALLBACK).toMatch(/normalizeInstallationId\(rawInstallationId\)/);
  });
});
