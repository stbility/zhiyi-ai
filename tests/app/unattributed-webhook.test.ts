import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * P0-6 付款归属失败账外表契约(2026-08-13 修复)。
 *
 * 背景:webhook 三条归属路全部失败且订阅行不存在时 throw 吃 5xx 让
 * Stripe 重试到放弃 —— 付款与权益永久丢失,用户与管理员均无感知。
 *
 * 修复:归属失败/套餐判定失败 → 落 unattributed_subscriptions 表(留痕
 * 含付款邮箱)→ 返回 200;人工凭邮箱补录(runbook 第十章)。
 */
const WEBHOOK = readFileSync(
  resolve(__dirname, "../../src/app/api/billing/webhook/route.ts"),
  "utf8",
);
const MIGRATION = readFileSync(
  resolve(__dirname, "../../supabase/migrations/0061_unattributed_subscriptions.sql"),
  "utf8",
);
const RUNBOOK = readFileSync(
  resolve(__dirname, "../../docs/payment-loop-runbook.md"),
  "utf8",
);

describe("P0-6 付款归属失败留痕", () => {
  it("归属失败不再 throw(死循环重试),改入账外表", () => {
    expect(WEBHOOK).toMatch(/await recordUnattributed\(admin, stripe, subscription, "unknown"\)/);
    expect(WEBHOOK).not.toMatch(/无法确定订阅 \$\{subscription\.id\} 所属用户/);
  });

  it("套餐判定失败同样入账外表(plan_id='unknown'),不静默降级 free", () => {
    // planId 判不出 → recordUnattributed
    const planBlock = WEBHOOK.slice(
      WEBHOOK.indexOf("if (!planId)"),
      WEBHOOK.indexOf("const { error } = await admin.from(\"subscriptions\").upsert"),
    );
    expect(planBlock).toMatch(/recordUnattributed/);
    expect(planBlock).not.toMatch(/throw new Error/);
    // 不静默降级 free 的注释仍在(语义保留)
    expect(planBlock).toMatch(/绝不静默降级 free/);
  });

  it("recordUnattributed 读取 customer 邮箱作为认领线索,attempts 递增", () => {
    expect(WEBHOOK).toMatch(/async function recordUnattributed/);
    expect(WEBHOOK).toMatch(/customer_email/);
    expect(WEBHOOK).toMatch(/attempts/);
    expect(WEBHOOK).toMatch(/stripe\.customers\.retrieve/);
  });

  it("迁移 0061:账外表仅 service_role 可访问(authenticated/anon 全拒)", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.unattributed_subscriptions/);
    expect(MIGRATION).toMatch(/revoke all on public\.unattributed_subscriptions from authenticated, anon/);
    expect(MIGRATION).not.toMatch(/create policy/);
  });

  it("runbook 提供人工认领流程(SQL 可执行)", () => {
    expect(RUNBOOK).toMatch(/unattributed_subscriptions/);
    expect(RUNBOOK).toMatch(/人工认领/);
    expect(RUNBOOK).toMatch(/insert into public\.subscriptions/);
  });
});
