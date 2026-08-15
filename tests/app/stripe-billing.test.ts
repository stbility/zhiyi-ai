import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Stripe 商业闭环 —— 订阅、权益矩阵、用量计量。
 *
 * 覆盖 0033/0034/0035 三份迁移的关键契约:
 *   · 订阅状态机锁死(只认 active/trialing 为有效权益)
 *   · plan_id 白名单对齐 plans.ts 三档
 *   · 无订阅 = free(最重要的兜底,漏配订阅绝不允许等于漏配权益)
 *   · 权益判断走 security definer 函数,不信任客户端 plan
 *   · 用量按 (user, month, category) 聚合,upsert 计数并发安全
 */

const ROOT = resolve(__dirname, "../..");
const M0033 = readFileSync(
  resolve(ROOT, "supabase/migrations/0033_stripe_customers_and_subscriptions.sql"),
  "utf8",
);
const M0034 = readFileSync(
  resolve(ROOT, "supabase/migrations/0034_entitlements.sql"),
  "utf8",
);
const M0035 = readFileSync(
  resolve(ROOT, "supabase/migrations/0035_usage_metering.sql"),
  "utf8",
);
const M0036 = readFileSync(
  resolve(ROOT, "supabase/migrations/0037_entitlements_quota_alignment.sql"),
  "utf8",
);
const PLANS = readFileSync(resolve(ROOT, "src/lib/plans.ts"), "utf8");

describe("0033 Stripe 客户与订阅", () => {
  it("有 stripe_customers 表 —— 本站用户 ↔ Stripe 客户映射", () => {
    expect(M0033).toContain("create table if not exists public.stripe_customers");
    expect(M0033).toMatch(/user_id\s+uuid primary key references auth\.users/);
    expect(M0033).toMatch(/customer_id\s+text not null unique/);
  });

  it("有 subscriptions 表 —— 一条记录 = 一个订阅期", () => {
    expect(M0033).toContain("create table if not exists public.subscriptions");
    expect(M0033).toMatch(/stripe_subscription_id\s+text not null unique/);
  });

  it("订阅状态机锁死 —— 权益判断只认 active/trialing", () => {
    expect(M0033).toMatch(/status\s+text not null/);
    expect(M0033).toMatch(
      /check \(status in \('active','trialing','past_due','canceled','unpaid','incomplete','paused','incomplete_expired'\)\)/,
    );
  });

  it("plan_id 白名单对齐 plans.ts 五档", () => {
    expect(M0033).toMatch(/check \(plan_id in \('free','professional','professional_plus','team','enterprise'\)\)/);
    // plans.ts 里必须有同样的五档
    expect(PLANS).toContain('id: "free"');
    expect(PLANS).toContain('id: "professional"');
    expect(PLANS).toContain('id: "professional_plus"');
    expect(PLANS).toContain('id: "team"');
    expect(PLANS).toContain('id: "enterprise"');
  });

  it("写路径只走 webhook —— 用户无 INSERT/UPDATE/DELETE 策略", () => {
    expect(M0033).toContain("subscriptions_select_own");
    expect(M0033).not.toContain("subscriptions_insert");
    expect(M0033).not.toContain("subscriptions_update");
    expect(M0033).not.toContain("subscriptions_delete");
  });

  it("checkout 路由写 stripe_customers 走 service_role(42501 修复)", () => {
    // 2026-08-15 生产 42501 修复:stripe_customers 只有 SELECT policy,
    // 写仅限 service_role(0033 安全模型)。checkout 此前用用户会话
    // 客户端 upsert → 新用户首购即被 RLS 拒,表永远 0 行。
    // 契约:客户映射的写入必须走 admin(service_role)客户端。
    const CHECKOUT = readFileSync(
      resolve(ROOT, "src/app/api/billing/checkout/route.ts"),
      "utf8",
    );
    // 整个文件层面:admin 客户端 + upsert 链必须成对出现
    expect(CHECKOUT).toMatch(
      /createSupabaseAdminClient\(\)[\s\S]*?const \{ error: mapError \} = await admin\s*\.from\("stripe_customers"\)\s*\.upsert\(/,
    );
    // 表侧:stripe_customers 无 INSERT policy(用户永远不能自写客户映射)
    expect(M0033).not.toContain("stripe_customers_insert");
    expect(M0033).not.toContain("stripe_customers_update");
  });

  it("订阅状态是权益唯一事实来源 —— 不信任客户端传的 plan", () => {
    expect(M0033).toContain("由 webhook 从 Stripe Price 的 metadata.plan_id 映射而来");
    expect(M0033).toContain("不在客户端传");
  });
});

describe("0034 权益矩阵", () => {
  it("有 entitlements 静态表 —— plan × feature → quota", () => {
    expect(M0034).toContain("create table if not exists public.entitlements");
    expect(M0034).toMatch(/quota\s+integer\s*,\s*-- null = 不限制/);
    expect(M0034).toMatch(/primary key \(plan_id, feature\)/);
  });

  it("默认权益:Free 1 工作流 / Professional 5 / Enterprise 不限", () => {
    expect(M0034).toContain("('free',              'workflows',            1)");
    expect(M0034).toContain("('professional',      'workflows',            5)");
    expect(M0034).toContain("('enterprise',        'workflows',            null)");
  });

  it("月度 agent 额度:Free 100 / Professional 2000 / Enterprise 不限", () => {
    expect(M0034).toContain("('free',              'monthly_agent_turns',  100)");
    expect(M0034).toContain("('professional',      'monthly_agent_turns',  2000)");
    expect(M0034).toContain("('enterprise',        'monthly_agent_turns',  null)");
  });

  it("0037 配额对齐:五档权益(2026-08-11 重写,对齐新版落地页)", () => {
    expect(M0036).toContain("monthly_agent_turns");
    // 0037 重写后:pro=2000 已是 0034 初始值,ent=null 不限
    expect(M0036).toContain("professional_plus");
    expect(M0036).toContain("'professional_plus', 'monthly_agent_turns',  4000");
    expect(M0036).toContain("'team', 'monthly_agent_turns', 10000");
    // 约束放宽前置:0034 生产版 3 档 CHECK → 5 档
    expect(M0036).toContain("entitlements_plan_id_check");
    // 与 plans.ts 宣传文案一致(展示层 = 判断层)
    expect(PLANS).toContain("每月 2,000 次标准 Agent 运行");
    expect(PLANS).toContain("每月 4,000 次标准 Agent 运行");
    expect(PLANS).toContain("每月 10,000 次标准 Agent 运行");
  });

  it("get_entitlements 是 security definer —— 用调用者 user_id 参数,不信任客户端 plan", () => {
    expect(M0034).toContain("security definer");
    expect(M0034).toContain("get_entitlements(p_user_id uuid)");
    expect(M0034).toContain("p_user_id");
  });

  it("无订阅 = free —— 最重要的兜底", () => {
    expect(M0034).toContain("无订阅 = free");
    expect(M0034).toMatch(/coalesce\(\s*\(select s\.plan_id from public\.subscriptions/);
  });

  it("EXECUTE 只给 authenticated —— 匿名调不到", () => {
    expect(M0034).toContain("revoke execute on function public.get_entitlements");
    expect(M0034).toContain("grant execute on function public.get_entitlements");
  });
});

describe("0035 用量计量", () => {
  it("有 usage_metering 表 —— 按 (user, month, category) 聚合", () => {
    expect(M0035).toContain("create table if not exists public.usage_metering");
    expect(M0035).toMatch(/primary key \(user_id, period_month, category\)/);
    expect(M0035).toMatch(/period_month\s+text not null check \(period_month ~ '\^\\d\{4\}-\\d\{2\}\$'\)/);
  });

  it("类别白名单 —— agent_turns / rag_queries / storage_mb", () => {
    expect(M0035).toContain("'agent_turns', 'rag_queries', 'storage_mb'");
  });

  it("bump_usage 读+加+写一条语句 —— 并发安全(与 0013 同法)", () => {
    expect(M0035).toContain("on conflict (user_id, period_month, category)");
    expect(M0035).toContain("do update set units = public.usage_metering.units + excluded.units");
    expect(M0035).toContain("security definer");
  });

  it("get_monthly_usage 按当前 UTC 月查询", () => {
    expect(M0035).toContain("get_monthly_usage");
    expect(M0035).toContain("to_char(now() at time zone 'UTC', 'YYYY-MM')");
  });

  it("EXECUTE 授权收口 —— 匿名与 public 均 revoke", () => {
    expect(M0035).toContain("revoke execute on function public.bump_usage");
    expect(M0035).toContain("revoke execute on function public.get_monthly_usage");
  });
});
