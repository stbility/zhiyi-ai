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
 * 真正的验证仍然是拿一个全新的 PostgreSQL 跑一遍 supabase/migrations/
 * 再和生产库 diff。那需要开临时数据库(有成本),不在这个测试的范围内。
 * 把这一点写在这里,是为了不让人误以为「这个测试绿了 = 迁移链没问题」。
 */

const DIR = resolve(__dirname, "../../supabase/migrations");

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
 * 生产库快照。取自 2026-08-05 的
 *   select policyname from pg_policies where schemaname='public'
 *
 * 快照要跟着迁移一起改:改了策略就更新这里,两边对不上就是漂移。
 * 手工维护看着笨,但它把「生产是什么样」这件事**写进了仓库** ——
 * 在此之前,这个事实只存在于生产库里,谁都验证不了。
 */
const 生产策略 = [
  "ai_model_exclusions_delete_admin",
  "ai_model_exclusions_insert_admin",
  "ai_model_exclusions_select_member",
  "ai_model_exclusions_update_admin",
  "ai_models_delete_admin",
  "ai_models_insert_admin",
  "ai_models_select_member",
  "ai_models_update_admin",
  "ai_providers_delete_admin",
  "ai_providers_insert_admin",
  "ai_providers_select_member",
  "ai_providers_update_admin",
  "audit_logs_select_member",
  "conversation_attachments_own",
  "conversations_own",
  "git_installations_delete_admin",
  "git_installations_insert_admin",
  "git_installations_select_member",
  "git_installations_update_admin",
  "integrations_delete_admin",
  "integrations_insert_admin",
  "integrations_select_member",
  "integrations_update_admin",
  "mcp_access_tokens_delete_admin",
  "mcp_access_tokens_insert_admin",
  "mcp_access_tokens_select_member",
  "mcp_access_tokens_update_admin",
  "memberships_delete_admin",
  "memberships_insert_allowed",
  "memberships_select_member",
  "memberships_update_admin",
  "message_feedback_delete_own",
  "message_feedback_insert_own",
  "message_feedback_select_member",
  "message_feedback_update_own",
  "messages_own",
  "organizations_delete_owner",
  "organizations_insert_self",
  "organizations_select_visible",
  "organizations_update_admin",
  "platform_models_select_authenticated",
  "profiles_insert_self",
  "profiles_select_visible",
  "profiles_update_self",
  "workspace_files_delete_member",
  "workspace_files_insert_member",
  "workspace_files_select_member",
  "workspace_files_update_member",
  "workspaces_delete_admin",
  "workspaces_insert_member",
  "workspaces_select_member",
  "workspaces_update_member",
];

/** 同上,取自 pg_indexes,排除主键与唯一约束自动生成的那些 */
const 生产索引 = [
  "ai_model_exclusions_org_idx",
  "ai_models_org_idx",
  "ai_models_provider_idx",
  "ai_providers_created_by_idx",
  "ai_providers_org_idx",
  "audit_logs_actor_idx",
  "audit_logs_org_created_idx",
  "conversation_attachments_conversation_idx",
  "conversation_attachments_organization_idx",
  "conversations_org_channel_created_idx",
  "conversations_organization_idx",
  "conversations_user_idx",
  "conversations_workspace_idx",
  "git_installations_connected_by_idx",
  "git_installations_organization_idx",
  "integrations_created_by_idx",
  "integrations_organization_idx",
  "mcp_access_tokens_created_by_idx",
  "mcp_access_tokens_organization_idx",
  "memberships_org_idx",
  "memberships_user_idx",
  "message_feedback_created_by_idx",
  "message_feedback_message_idx",
  "message_feedback_organization_idx",
  "messages_conversation_idx",
  "messages_organization_idx",
  "messages_provider_idx",
  "organizations_created_by_idx",
  "platform_models_tier_idx",
  "rate_limits_window_idx",
  "workspace_files_conversation_idx",
  "workspace_files_organization_idx",
  "workspace_files_workspace_idx",
  "workspaces_created_by_idx",
  "workspaces_organization_idx",
];

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
