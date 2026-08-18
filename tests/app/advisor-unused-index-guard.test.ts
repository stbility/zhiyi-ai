import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Performance Advisor 0005 unused_index 处置契约(2026-08-15)。
 *
 * 背景:生产库 Performance Advisor 报 32 条 unused_index(idx_scan=0)。
 * 逐条核实后全部为【FK 列索引】或【功能必需索引】,一条都不能删:
 *
 *   1. FK 列索引 —— 官方 0001 unindexed_foreign_keys 是硬规则(FK 完整性/
 *      级联删除/join 性能);删了 0005 消失,0001 立刻报回来。
 *      0051 生产实测:0050 误删 4 条 FK 列索引后 0001 当场出现。
 *      0050 的教训与 0051 的结论已写死在迁移注释里。
 *
 *   2. 功能必需索引 —— (向量召回索引已因 2048 维超出 pgvector 2000 维上限移除)、
 *      system_logs_org/level_created_idx(日志查询路径)、
 *      sales_leads_status_idx(线索状态筛选)、
 *      unattributed_subscriptions_email_idx(认领流程按邮箱查)。
 *
 * 为什么 idx_scan=0 不代表无用:生产库表基本为空(订阅 0 行),
 * 空表/小表 Postgres 一律 seq scan,索引自然从未被扫。
 * 数据量上来后这些索引是 FK join / RLS 过滤 / 认领查询的必经路径。
 *
 * 【本测试守卫什么】
 *   若未来有人删这些索引(改迁移或新迁移 drop),测试变红 ——
 *   必须同时拿出「为什么 0001 不再适用」的证据,不许静默删。
 */
const DIR = resolve(__dirname, "../../supabase/migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

function stripSql(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
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

// 生产 Advisor 报的 32 条 unused_index(2026-08-15 CSV 导出)。
// 全部为 FK 列索引或功能必需索引 —— 不允许被任何迁移删除。
const PROTECTED_UNUSED_INDEXES = [
  "messages_organization_idx",
  "integrations_created_by_idx",
  "workspaces_created_by_idx",
  "conversations_workspace_idx",
  "git_installations_organization_idx",
  "git_installations_connected_by_idx",
  "message_feedback_organization_idx",
  "mcp_access_tokens_created_by_idx",
  "agent_runs_conversation_idx",
  "agent_runs_organization_idx",
  "memories_created_by_idx",
  "mcp_servers_created_by_idx",
  "skills_organization_idx",
  "skills_created_by_idx",
  "skill_files_skill_idx",
  "agent_runs_provider_idx",
  "eval_run_cases_run_idx",
  "eval_cases_feedback_idx",
  "knowledge_files_created_by_idx",
  "mcp_execution_log_token_idx",
  "mcp_execution_log_user_idx",
  "workflows_created_by_idx",
  "ai_providers_created_by_idx",
  "organizations_created_by_idx",
  "conversation_attachments_organization_idx",
  "audit_logs_actor_idx",
  "unattributed_subscriptions_email_idx",
  "system_logs_org_created_idx",
  "system_logs_level_created_idx",
  "sales_leads_status_idx",
  "unattributed_subscriptions_user_idx",
];

describe("Performance Advisor 0005 unused_index 处置契约", () => {
  it("32 条 Advisor 报的 unused 索引全部仍存在(一条都没被删)", () => {
    const live = finalIndexes();
    const missing = PROTECTED_UNUSED_INDEXES.filter((ix) => !live.has(ix));
    expect(
      missing,
      `这些索引被删了(Advisor 0005 报 unused 但实为 FK/功能索引,不允许删):${missing.join("、")}`,
    ).toEqual([]);
  });

  it("迁移 0063 补齐 system_logs.actor_id 外键索引(0001 修复)", () => {
    const m0063 = readFileSync(
      resolve(DIR, "0063_system_logs_actor_idx.sql"),
      "utf8",
    );
    expect(m0063).toMatch(/create index if not exists system_logs_actor_idx/);
    expect(m0063).toMatch(/on public\.system_logs \(actor_id\)/);
    // 0001 的语义必须保留在注释里:FK 列索引是硬规则,0005 不适用
    expect(m0063).toMatch(/unindexed_foreign_keys|0001/);
  });
});
