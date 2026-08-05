import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 把全部迁移**按顺序重放一遍**,算出最终的策略与索引集合,
 * 再和生产库的快照对比。
 *
 * 【为什么需要这个】
 * 原有的迁移测试只对**单个文件**做正则匹配 —— 检查的是「这个文件里
 * 写没写这句话」,而不是「全部跑完之后库长什么样」。两者完全是两回事。
 *
 * 它漏掉了一个真实问题:生产库的迁移账本里有
 * `merge_overlapping_policies_and_fk_indexes`,而仓库里**没有对应文件**
 * (编号从 0011 直接跳到 0013)。后果是从零重建出来的库与生产不一致 ——
 * 9 条策略名对不上、messages 少一个外键索引。
 * 灾难恢复这条路当时是断的,而所有测试都是绿的。
 *
 * 【这不能替代真实重放】
 * 本机没有 Docker 也没有 PostgreSQL,起不了真库。这个测试做的是**静态
 * 重放**:只跟踪 create/drop policy 与 create index,算不出约束、触发器、
 * 函数、列级授权。它能挡住「漏了一整条迁移」和「策略集合漂移」这两类,
 * 挡不住语法错误和依赖顺序问题。
 *
 * 真实重放现在**在 CI 里跑**:.github/workflows/ci.yml 起一个 postgres:16
 * 服务容器,scripts/check-migrations.sh 从空库把 migrations/ 全量应用一遍,
 * 再和同一份期望清单 diff。开发机上没有 Docker 也没有 PostgreSQL,
 * 所以这件事在本机做不到 —— 而做不到,正是漏掉整条 0012 没被发现的原因。
 *
 * 这个测试仍然保留,理由是它**快**:本机改迁移时秒级反馈,
 * 不必等一轮 CI。两者用的是同一份期望清单,不会各说各的。
 */

const DIR = resolve(__dirname, "../../supabase/migrations");

/** 期望清单与 scripts/check-migrations.sh 共用,不在两处各写一份 */
function 读清单(name: string): string[] {
  return readFileSync(resolve(__dirname, "../../supabase/test", name), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** 按文件名排序重放 —— 与 Supabase 应用迁移的顺序一致 */
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** 剥注释。SQL 的行注释是 --,块注释是 /* *​/ */
function stripSql(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
}

/** 重放所有迁移,得到最终的策略名集合 */
function finalPolicies(): Set<string> {
  const live = new Set<string>();
  for (const f of FILES) {
    const sql = stripSql(readFileSync(resolve(DIR, f), "utf8"));

    // 先删后建:同一个文件里常见 drop + create 同名策略的写法
    for (const m of sql.matchAll(
      /drop\s+policy\s+(?:if\s+exists\s+)?([a-z0-9_]+)\s+on/gi,
    )) {
      live.delete(m[1]!.toLowerCase());
    }
    for (const m of sql.matchAll(/create\s+policy\s+([a-z0-9_]+)\s+on/gi)) {
      live.add(m[1]!.toLowerCase());
    }
  }
  return live;
}

function finalIndexes(): Set<string> {
  const live = new Set<string>();
  for (const f of FILES) {
    const sql = stripSql(readFileSync(resolve(DIR, f), "utf8"));
    for (const m of sql.matchAll(
      /drop\s+index\s+(?:if\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi,
    )) {
      live.delete(m[1]!.toLowerCase());
    }
    for (const m of sql.matchAll(
      /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s+on/gi,
    )) {
      live.add(m[1]!.toLowerCase());
    }
  }
  return live;
}

/**
 * 生产库快照 —— **与 CI 里那个真实重放用的是同一份文件**。
 *
 * 事实只能有一处。分成两份的话,静态门禁和 CI 会各说各的,
 * 而「两边都绿」会变成一种毫无意义的安心。
 *
 * 取自 2026-08-05 的
 *   select policyname from pg_policies where schemaname='public'
 *
 * 快照要跟着迁移一起改:改了策略就更新这里,两边对不上就是漂移。
 * 手工维护看着笨,但它把「生产是什么样」这件事**写进了仓库** ——
 * 在此之前,这个事实只存在于生产库里,谁都验证不了。
 */
const 生产策略 = 读清单("expected-policies.txt");

/** 同上,取自 pg_indexes,排除主键与唯一约束自动生成的那些 */
const 生产索引 = 读清单("expected-indexes.txt");

describe("迁移编号连续", () => {
  it("没有断号", () => {
    // 断号本身不影响应用顺序(按文件名排序),但它是**漏了一整条迁移**
    // 最直接的信号 —— 0012 缺失正是这么暴露的。
    const nums = FILES.map((f) => Number(f.slice(0, 4))).sort((a, b) => a - b);
    const 断号: string[] = [];
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] !== nums[i - 1]! + 1) {
        断号.push(`${nums[i - 1]} → ${nums[i]}`);
      }
    }
    expect(断号, `迁移编号不连续:${断号.join("、")}`).toEqual([]);
  });
});

describe("重放全部迁移后的策略集合与生产一致", () => {
  const live = finalPolicies();

  it("没有生产缺失的策略(重建后会缺 → 功能坏掉)", () => {
    const 缺 = 生产策略.filter((p) => !live.has(p));
    expect(缺, `重建出来的库会缺这些策略:${缺.join("、")}`).toEqual([]);
  });

  it("没有生产之外的多余策略(重建后会多 → 权限可能变宽)", () => {
    const 多 = [...live].filter((p) => !生产策略.includes(p)).sort();
    expect(多, `重建出来的库会多这些策略:${多.join("、")}`).toEqual([]);
  });
});

describe("重放全部迁移后的索引集合与生产一致", () => {
  const live = finalIndexes();

  it("没有生产缺失的索引", () => {
    // messages_provider_idx 缺失时,删一个服务商要对 messages 全表扫描,
    // 而那是增长最快的表 —— 用户在「模型服务」页删服务商会卡住
    const 缺 = 生产索引.filter((i) => !live.has(i));
    expect(缺, `重建出来的库会缺这些索引:${缺.join("、")}`).toEqual([]);
  });
});

describe("守卫自己没有空转", () => {
  it("确实解析到了迁移文件", () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it("确实解析出了策略和索引", () => {
    // 正则一旦写坏,上面几条会因为「两边都是空」而全绿
    expect(finalPolicies().size).toBeGreaterThan(40);
    expect(finalIndexes().size).toBeGreaterThan(25);
  });
});

describe("迁移清单覆盖每一个文件", () => {
  /**
   * 清单(MANIFEST.md)把「仓库文件 ↔ 生产账本」这层对应关系写进仓库。
   * 在此之前它只存在于生产库里,谁都验证不了 —— 而正是这个缺口
   * 让整条 0012 只存在于生产、从未进过仓库。
   *
   * 清单漏记一个文件,就等于这层对应关系又出现了一个盲区。
   */
  const MANIFEST = readFileSync(
    resolve(__dirname, "../../supabase/migrations/MANIFEST.md"),
    "utf8",
  );

  for (const f of FILES) {
    it(`${f} 在清单里`, () => {
      expect(MANIFEST, `${f} 没有记进 MANIFEST.md`).toContain(f);
    });
  }
});
