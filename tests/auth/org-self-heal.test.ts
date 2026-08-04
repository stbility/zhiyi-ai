import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 注册时没建上组织的用户,登录后要能自己好。
 *
 * 【为什么必须是自愈,不是一次性回填】
 *
 * 生产库 2026-08-04 的真实数据:4 个用户,只有 2 条成员关系。
 * 中间两个注册在 created_by 漏写的窗口期里,建组织静默失败,
 * 他们至今登录进去什么都做不了。
 *
 * 后来 bug 修好了,新注册正常 —— 但那两个人永远好不了,
 * 因为修复只作用于「接下来注册的人」。一次性回填能救他们这一次,
 * 却救不了下一次:只要这一步再出任何故障(数据库抖动、约束变更、限流),
 * 又会产生新的孤儿,而且同样没有任何用户可见的迹象。
 */

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const HEAL = read("src/lib/auth/personal-org.ts");
const QUERIES = read("src/lib/db/queries.ts");

describe("自愈挂在漏不掉的那个收口上", () => {
  /**
   * 需要组织的地方有 9 处,其中 api/integrations/github/callback 和
   * settings/integrations/git-actions 都**不经过 (app) 布局**。
   * 把自愈放布局里就会漏掉它们 —— 而「某条路径忘了处理」正是
   * 这类 bug 一再出现的方式。
   */
  it("挂在 getMyOrganizations 里,不是挂在某个布局里", () => {
    expect(QUERIES).toContain("ensurePersonalOrganization");
    const 布局 = read("src/app/(app)/layout.tsx");
    expect(布局, "自愈挂到布局上了 —— API 路由和服务端动作会漏掉").not.toContain(
      "ensurePersonalOrganization",
    );
  });

  it("补建之后要重查一次,不是拿空数组返回", () => {
    // 只补建不重查的话,这一次请求仍然看到「没有组织」,
    // 用户得自己刷新一下才好 —— 而他不知道要刷新
    expect(QUERIES).toMatch(/补建了[\s\S]{0,200}queryMyMemberships\(\)/);
  });
});

describe("只在确认为空时才动手", () => {
  it("查询失败与查到 0 条要分开", () => {
    // 混为一谈的话,一次网络抖动会被当成「这个用户没有组织」,
    // 触发一次毫无必要的补建 —— 用户凭空多出一个组织
    expect(QUERIES).toMatch(/return null/);
    expect(QUERIES).toMatch(/rows === null/);
  });

  it("admin 查得到、用户身份查不到时,不补建", () => {
    // 这种情况是 RLS 策略出了问题,不是没有组织。
    // 补建只会凭空多一个组织,把真正的故障盖住。
    expect(HEAL).toMatch(/疑似 RLS 策略问题,未补建/);
    expect(HEAL).toMatch(/if \(existing && existing\.length > 0\)/);
  });

  it("没有 service role 时如实记一笔,不静默返回", () => {
    // 静默返回会让「用户进去是空的」变成一个查不出原因的现象
    expect(HEAL).toMatch(/无法补建个人组织/);
  });
});

describe("并发安全靠数据库的唯一约束,不自己加锁", () => {
  it("slug 后缀从 userId 派生,不是随机数", () => {
    // 随机后缀:两个并发请求各建一个组织,用户凭空多出一个。
    // 确定后缀:第二个撞上 organizations_slug_key(UNIQUE)而失败,
    // 重查即可拿到第一个建好的那个。
    expect(HEAL).toMatch(/userId\.replace\(\/-\/g, ""\)\.slice\(0, 8\)/);
    expect(HEAL, "又用回随机后缀了 —— 并发时会建出两个组织").not.toMatch(
      /randomUUID/,
    );
  });

  it("依赖的那个唯一约束确实存在 —— 前提校验", () => {
    // 约束没了的话上面那条就是空转,而且是静默空转
    const m = read("supabase/migrations/0001_identity_and_orgs.sql");
    expect(m).toMatch(/slug\s+text\s+not null\s+unique/i);
  });
});

describe("注册与自愈用同一份实现", () => {
  it("注册动作里不再有第二份建组织逻辑", () => {
    const ACTIONS = read("src/app/(auth)/register/actions.ts");
    expect(
      ACTIONS,
      "注册动作里又出现了 insert organizations —— 两份实现迟早分叉",
    ).not.toMatch(/\.from\("organizations"\)\s*\n?\s*\.insert/);
    expect(ACTIONS).toContain("createPersonalOrganization");
  });

  it("成员关系失败仍然回滚已建的组织", () => {
    // 留下一个谁都看不见的组织,比一开始就没建更糟
    expect(HEAL).toMatch(
      /memberError[\s\S]{0,400}?\.from\("organizations"\)\s*\n?\s*\.delete\(\)/,
    );
  });
});
