import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * P0-3 Enterprise「联系销售」行为契约(2026-08-13 修复)。
 *
 * 背景:定价页 Enterprise CTA 此前直接跳硬编码 Stripe Payment Link
 * (buy.stripe.com/cNi00kgBt3078DUaCa5AQ02),与 Team 档共用同一 URL;
 * STRIPE_PRICE_ENT_* 未配置不影响跳转;付款邮箱≠注册邮箱时订阅静默丢失。
 *
 * 修复:
 *   1. Enterprise CTA → 站内 /contact 询价表单(不再出现任何 Stripe 付款链接)
 *   2. plans.ts 删除 Team 对 ENT URL 的回退与 ENT/TEAM 的硬编码默认链接
 *   3. 表单提交落 sales_leads 表(迁移 0063,RLS 只允许本人读写)
 */
const PLANS = readFileSync(resolve(__dirname, "../../src/lib/plans.ts"), "utf8");
const SECTION = readFileSync(
  resolve(__dirname, "../../src/components/marketing/PlansSection.tsx"),
  "utf8",
);
const CONTACT_PAGE = readFileSync(
  resolve(__dirname, "../../src/app/(app)/contact/page.tsx"),
  "utf8",
);
const CONTACT_ACTIONS = readFileSync(
  resolve(__dirname, "../../src/app/(app)/contact/actions.ts"),
  "utf8",
);
const MIGRATION = readFileSync(
  resolve(__dirname, "../../supabase/migrations/0059_sales_leads.sql"),
  "utf8",
);

describe("P0-3 Enterprise 联系销售 = 站内询价表单", () => {
  it("Enterprise CTA 指向站内 /contact,不再指向 Stripe 付款链接", () => {
    expect(SECTION).toMatch(/enterpriseHref = isFree \? "\/register" : "\/contact"/);
    // 不再用 paymentLink 拼 enterprise 跳转
    const enterpriseBlock = SECTION.slice(
      SECTION.indexOf("plan.id === \"enterprise\""),
      SECTION.indexOf("return (\n      <PricingCard"),
    );
    expect(enterpriseBlock).not.toMatch(/paymentLink/);
  });

  it("plans.ts 的 ENT/TEAM Payment Link 不再硬编码、不再互相回退(Pro/Pro+ 的 503 降级链接保留)", () => {
    // 只匹配赋值表达式(注释里的环境变量说明不含 process.env)
    // ENT:env-only,赋值无 ?? 默认 URL
    expect(PLANS).not.toMatch(/STRIPE_PAYMENT_LINK_ENT_MONTH\s*=\s*process\.env[^\n]*\?\?/);
    expect(PLANS).not.toMatch(/STRIPE_PAYMENT_LINK_ENT_YEAR\s*=\s*process\.env[^\n]*\?\?/);
    // TEAM:env-only,赋值无 ?? 回退(不再指向 ENT URL)
    expect(PLANS).not.toMatch(/STRIPE_PAYMENT_LINK_TEAM_MONTH\s*=\s*process\.env[^\n]*\?\?/);
    expect(PLANS).not.toMatch(/STRIPE_PAYMENT_LINK_TEAM_YEAR\s*=\s*process\.env[^\n]*\?\?/);
    expect(PLANS).toMatch(
      /STRIPE_PAYMENT_LINK_TEAM_MONTH: string \| undefined =\n  process\.env\.STRIPE_PAYMENT_LINK_TEAM_MONTH;/,
    );
  });

  it("/contact 询价页与提交 action 存在", () => {
    expect(CONTACT_PAGE).toMatch(/联系销售/);
    expect(CONTACT_ACTIONS).toMatch(/export async function submitSalesLead/);
    expect(CONTACT_ACTIONS).toMatch(/sales_leads/);
  });

  it("迁移 0063:线索表 + 本人读写 RLS", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.sales_leads/);
    expect(MIGRATION).toMatch(/sales_leads_select_self/);
    expect(MIGRATION).toMatch(/created_by = \(select auth\.uid\(\)\)/);
  });
});
