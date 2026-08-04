import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { personalOrgSlug } = await import("@/lib/auth/personal-org");

/**
 * 注册后自动建组织必须真的成功。
 *
 * 真实回归:上一版插入 organizations 时漏了 created_by,而迁移 0001 里
 * 那一列是 NOT NULL。于是每次注册都撞 23502,走进「自动创建个人组织失败」
 * 的日志分支后静默返回 —— 「新用户注册即可用」这个功能**从来没有生效过**,
 * 而且因为失败被设计成不阻断注册,用户侧没有任何迹象:
 * 他只是进去之后照样看到「需要先创建组织」。
 *
 * 一个 insert 少写一个字段的错误,任何一条「注册后应当拥有一个组织」的
 * 测试都能挡住。所以这里对着**迁移里真实的 NOT NULL 约束**校验代码,
 * 而不是等它上生产。
 */

const ROOT = resolve(__dirname, "../..");

// 建组织的实现已经从注册动作里提到 lib/auth/personal-org.ts —— 注册和
// 「登录时发现没有组织就补建」两条路必须用**同一份**实现。
// 各写一份的话,slug 规则、必填列、回滚逻辑迟早分叉,而分叉的表现
// 就是「注册的人没事,补建的人建出一个撞 CHECK 的标识」这种极难查的故障。
const REGISTER_RAW = readFileSync(
  resolve(ROOT, "src/lib/auth/personal-org.ts"),
  "utf8",
);

/**
 * 剥掉注释再检查。
 *
 * 注释里写着「上一版是调 listUsers()…」是**记录踩过的坑**,不是违规代码。
 * 按原文搜会把这类说明误判成问题 —— 那会逼着人删掉最有价值的注释。
 */
const REGISTER = REGISTER_RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /\/\/.*$/gm,
  "",
);
const MIGRATION_0001 = readFileSync(
  resolve(ROOT, "supabase/migrations/0001_identity_and_orgs.sql"),
  "utf8",
);

/** 从建表语句里挑出 NOT NULL 且没有默认值的列 —— 插入时必须显式给值 */
function requiredColumns(sql: string, table: string): string[] {
  const block = new RegExp(
    `create table[^;]*?public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
    "i",
  ).exec(sql)?.[1];
  if (!block) return [];

  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /not null/i.test(l) && !/default/i.test(l))
    .map((l) => l.split(/\s+/)[0] ?? "")
    .filter((c) => c && !/^(primary|unique|foreign|constraint|check)$/i.test(c));
}

describe("注册后自动建个人组织", () => {
  it("插入语句覆盖了 organizations 所有必填列", () => {
    const required = requiredColumns(MIGRATION_0001, "organizations");
    // 前提校验:约束确实存在,否则这条测试是空转
    expect(required).toContain("created_by");

    const insert = /\.from\("organizations"\)\s*\n?\s*\.insert\(\{([\s\S]*?)\}\)/.exec(
      REGISTER,
    )?.[1];
    expect(insert, "找不到 organizations 的插入语句").toBeTruthy();

    const missing = required.filter((col) => !insert!.includes(col));
    expect(
      missing,
      `插入 organizations 时缺少必填列:${missing.join("、")}`,
    ).toEqual([]);
  });

  it("user id 取自 createUser 的返回值,不去翻全站用户表", () => {
    // listUsers() 默认每页 50 条 —— 平台用户超过 50 之后新用户就不在第一页,
    // 找不到就不建成员关系,还会留下一个谁都看不见的孤儿组织。
    //
    // 这一条守的是**注册动作**那一侧(它负责拿到 userId),
    // 而 created_by 写没写在建组织那一侧 —— 两个文件各看各的,
    // 混在一起搜的话,哪边坏了都指不出来。
    const ACTIONS = readFileSync(
      resolve(ROOT, "src/app/(auth)/register/actions.ts"),
      "utf8",
    );
    expect(ACTIONS).not.toContain("listUsers");
    expect(ACTIONS).toMatch(/data:\s*createdUser[\s\S]*?createUser\(/);
    expect(ACTIONS).toMatch(
      /createPersonalOrganization\(\s*admin,\s*email,\s*createdUser\.user\.id/,
    );
    expect(REGISTER).toContain("created_by: userId");
  });

  it("成员关系失败时回滚已建的组织", () => {
    // 留下一个谁都看不见的组织,比一开始就没建更糟
    expect(REGISTER).toMatch(
      /memberError[\s\S]{0,400}?\.from\("organizations"\)\s*\n?\s*\.delete\(\)/,
    );
  });
});

/**
 * 组织标识必须满足数据库的 CHECK,不只是「字符合法」。
 *
 * 约束是 ^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$ —— **必须以字母或数字开头和结尾**。
 * 上一版只做字符替换就直接用,于是 `-foo@x.com` 得到 `-foo-abc123`、
 * `___@x.com` 得到 `----abc123`,插入时撞 CHECK,自动建组织再次静默失败。
 *
 * 这和 N1(漏了 created_by)是同一类问题:光看「字段给了没」不够,
 * 还得看「值满足约束没」。所以这里直接用**迁移里那条正则**去验。
 */
describe("组织标识生成", () => {
  const CHECK = (() => {
    const m = /slug\s+text[^,]*check \(slug ~ '([^']+)'\)/.exec(MIGRATION_0001);
    return new RegExp(m?.[1] ?? "^$");
  })();

  // 直接用**真实实现**,不复刻。
  // 复刻的那一份只能证明"我脑子里的逻辑对",证明不了线上跑的那份对 ——
  // 上一版就得再补一条源码正则去追认,而正则一改写法就失效。
  const slugFor = (email: string) =>
    personalOrgSlug(email, "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");

  it("约束确实要求首尾是字母或数字 —— 前提校验", () => {
    expect(CHECK.source).toContain("^[a-z0-9]");
    expect(CHECK.test("-foo-a1b2c3")).toBe(false);
  });

  it.each([
    "-foo@x.com",
    "___@x.com",
    "...@x.com",
    "a@x.com",
    "foo.bar+tag@x.com",
    "UPPER@x.com",
    "很长的中文名字@x.com",
    "a".repeat(60) + "@x.com",
    "-@x.com",
  ])("%s 生成的标识满足 CHECK", (email) => {
    const slug = slugFor(email);
    expect(CHECK.test(slug), `不满足约束的标识:${slug}`).toBe(true);
  });

  it("后缀从 userId 派生,同一个用户永远得到同一个标识", () => {
    // 这是自愈的幂等保证:两个并发请求同时发现"没有组织"时,
    // 随机后缀会各建一个、用户凭空多出一个组织;确定后缀会让第二个
    // 撞上 organizations_slug_key(UNIQUE),重查即可拿到第一个建好的。
    // 用数据库已有的唯一约束做互斥,不必自己加锁。
    const a = personalOrgSlug("x@y.com", "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    const b = personalOrgSlug("x@y.com", "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    expect(a).toBe(b);

    const 另一个人 = personalOrgSlug("x@y.com", "ffffffff-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    expect(另一个人, "不同用户撞到了同一个标识").not.toBe(a);
  });
});
