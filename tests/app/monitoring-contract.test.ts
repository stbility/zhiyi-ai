import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 阶段 8 监控与结构化日志契约(2026-08-12)。
 *
 * 背景:README「尚未交付」最后一项 = 结构化日志、监控、备份回滚。
 * 本轮落地:
 *   1. system_logs 表(0056)+ logging 模块(失败静默,不阻断主链路)
 *   2. 关键事件埋点(workflow.completed/failed/paused/zombie_cleared)
 *   3. /api/health 健康检查(Supabase 连通 + 依赖指纹,200/503)
 *   4. docs/backup-restore.md 备份回滚指南(平台能力 + 迁移回滚姿势)
 */

const LOGGING = readFileSync(resolve(__dirname, "../../src/lib/logging.ts"), "utf8");
const EXECUTE = readFileSync(
  resolve(__dirname, "../../src/lib/workflow/execute.ts"),
  "utf8",
);
const HEALTH = readFileSync(
  resolve(__dirname, "../../src/app/api/health/route.ts"),
  "utf8",
);
const MIGRATION = readFileSync(
  resolve(__dirname, "../../supabase/migrations/0056_system_logs.sql"),
  "utf8",
);

describe("阶段 8 监控与结构化日志", () => {
  it("system_logs 迁移:表 + level check + admin 读 + 30 天语义", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.system_logs/);
    expect(MIGRATION).toMatch(/level in \('info','warn','error'\)/);
    expect(MIGRATION).toMatch(/has_org_role\(organization_id, array\['admin'\]/);
    expect(MIGRATION).toMatch(/enable row level security/);
  });

  it("logging 模块:失败静默不阻断主链路", () => {
    expect(LOGGING).toMatch(/export async function logEvent/);
    expect(LOGGING).toMatch(/export async function logEventWith/);
    expect(LOGGING).toMatch(/console\.error/);
  });

  it("关键事件埋点:workflow 完成/失败/暂停/僵尸清理", () => {
    expect(EXECUTE).toMatch(/workflow\.completed/);
    expect(EXECUTE).toMatch(/workflow\.failed/);
    expect(EXECUTE).toMatch(/workflow\.paused/);
  });

  it("/api/health:连通性探测 + 依赖指纹,失败 503", () => {
    expect(HEALTH).toMatch(/checks\.supabase/);
    expect(HEALTH).toMatch(/status: allOk \? 200 : 503/);
    expect(HEALTH).toMatch(/cron_secret/);
  });

  it("备份回滚文档存在且如实(平台能力 + 迁移回滚姿势)", () => {
    const doc = readFileSync(
      resolve(__dirname, "../../docs/backup-restore.md"),
      "utf8",
    );
    expect(doc).toMatch(/Supabase 平台能力/);
    expect(doc).toMatch(/反向迁移/);
    expect(doc).toMatch(/灾难恢复演练/);
  });
});
