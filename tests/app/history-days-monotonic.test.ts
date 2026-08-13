import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * P0-5 历史权益倒挂契约(2026-08-13 修复)。
 *
 * 背景:0055 给 free 配 history_days=null,实现层把 null 解释为「永久保留」,
 * 于是 Free 可见历史 > Professional(90 天),权益不单调,降级后反而看到更多。
 *
 * 修复:0060 迁移把 free 改为 7 天;null 语义保留为「永久」仅 team/enterprise。
 */
const MIGRATION = readFileSync(
  resolve(__dirname, "../../supabase/migrations/0060_entitlements_history_days_free.sql"),
  "utf8",
);
const CONVERSATIONS = readFileSync(
  resolve(__dirname, "../../src/lib/db/conversations.ts"),
  "utf8",
);

describe("P0-5 历史权益单调", () => {
  it("迁移把 free 的 history_days 改为 7", () => {
    expect(MIGRATION).toMatch(/'free', 'history_days', 7/);
    expect(MIGRATION).toMatch(/on conflict \(plan_id, feature\) do update/);
  });

  it("pro 90 / plus 365 保持不变(迁移不触碰)", () => {
    expect(MIGRATION).not.toMatch(/'professional', 'history_days'/);
    expect(MIGRATION).not.toMatch(/'professional_plus', 'history_days'/);
  });

  it("实现层注释反映新语义(null=永久仅 Team/Enterprise,free=7 天)", () => {
    expect(CONVERSATIONS).toMatch(/free 从 null.*改为 7 天/);
    expect(CONVERSATIONS).toMatch(/quota=null → 永久保留/);
  });
});
