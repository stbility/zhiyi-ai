import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Enterprise 订阅入口契约。
 *
 * 背景:
 *   P0-3(2026-08-13 上午):定价页 Enterprise CTA 此前直接跳硬编码 Stripe
 *   Payment Link(buy.stripe.com/cNi00kgBt3078DUaCa5AQ02),与 Team 档共用
 *   同一 URL;STRIPE_PRICE_ENT_* 未配置不影响跳转;付款邮箱≠注册邮箱时
 *   订阅静默丢失。当时改为站内 /contact 询价表单。
 *
 *   2026-08-13(定价 v2):Enterprise 标准定价 HK1,999/月、HK19,990/年
 *   (中大型企业),独立 Payment Link(ENT_MONTH/ENT_YEAR,与 Team 的
 *   HK499/4,990 链接区分开)。
 *   Enterprise 恢复为与其他付费档一致的「立即订阅」按钮(SubscribeButton),
 *   /contact 询价页保留为独立入口。ENT/TEAM Payment Link 一律 env-only,
 *   不硬编码、不互相回退。
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

describe("Enterprise 订阅入口(2026-08-13 标准定价,取代 P0-3 联系销售 CTA)", () => {
  it("Enterprise 与其他付费档一致走 SubscribeButton,不再强制跳 /contact", () => {
    // 付费档统一渲染 SubscribeButton(planId 收窄包含 enterprise),
    // enterprise 不再是「联系销售」特殊分支
    expect(SECTION).toMatch(
      /const paidPlanId = plan\.id as "professional" \| "professional_plus" \| "team" \| "enterprise";/,
    );
    // 已无 enterpriseHref(旧 P0-3 分支)
    expect(SECTION).not.toMatch(/enterpriseHref/);
  });

  it("Enterprise 定价已实化(定价 v2:HK1,999/月、HK19,990/年)", () => {
    expect(PLANS).toContain('name: "Enterprise 企业版"');
    expect(PLANS).toContain('price: "HK1,999/月"');
    expect(PLANS).toContain('annualPrice: "HK19,990/年"');
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

  it("/contact 询价页与提交 action 仍存在(独立入口)", () => {
    expect(CONTACT_PAGE).toMatch(/联系销售/);
    expect(CONTACT_ACTIONS).toMatch(/export async function submitSalesLead/);
    expect(CONTACT_ACTIONS).toMatch(/sales_leads/);
  });

  it("迁移 0059:线索表 + 本人读写 RLS", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.sales_leads/);
    expect(MIGRATION).toMatch(/sales_leads_select_self/);
    expect(MIGRATION).toMatch(/created_by = \(select auth\.uid\(\)\)/);
  });
});
