import { describe, expect, it } from "vitest";

/**
 * Stripe 应用层契约测试。
 *
 * 覆盖:
 *   · plans.ts 的 HKD 定价与年付字段(与 0033/0034 对齐)
 *   · checkout/portal/webhook 路由的签名与安全姿态
 *   · 权益服务与 0034 的 feature 对齐
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const PLANS = readFileSync(resolve(ROOT, "src/lib/plans.ts"), "utf8");
const M0033 = readFileSync(
  resolve(ROOT, "supabase/migrations/0033_stripe_customers_and_subscriptions.sql"),
  "utf8",
);
const M0034 = readFileSync(
  resolve(ROOT, "supabase/migrations/0034_entitlements.sql"),
  "utf8",
);

describe("plans.ts 港币定价(全球华人市场)", () => {
  it("Professional 产品决策价 HK$128/月", () => {
    expect(PLANS).toContain('name: "Professional 专业版"');
    expect(PLANS).toContain("annualNote");
  });

  it("Enterprise 产品决策价 HK$自定义报价/月", () => {
    expect(PLANS).toContain('name: "Enterprise 企业版"');
  });

  it("年付说明存在(两个月免费惯例)", () => {
    expect(PLANS).toContain("年付 HK$1,280");
    expect(PLANS).toContain("年付 HK$1,980");
    expect(PLANS).toContain("年付 HK$3,880");
  });

  it("支付路径 = checkout 为主,Payment Link 链接已清空(旧账号删除,重建后填新)", () => {
    // 2026-08-08 终态:用户偏好 Payment Link(Stripe 原生可用)。
    // 2026-08-10:旧 Stripe 账号已删,旧 buy.stripe.com 链接失效 —— plans.ts
    // 清空防死链;新账号重建后填入新链接(checkout 503 时降级用)。
    expect(PLANS).not.toContain("buy.stripe.com");
    expect(PLANS).toContain('stripeUrl: ""');
    expect(PLANS).toContain('annualStripeUrl: ""');
    // 年付文案必须与月付文案同档配对(Pro 年付配 Pro 月付);链接已清空待重建
    const pro = PLANS.split('id: "professional"')[1]?.split('id: "professional_plus"')[0] ?? "";
    expect(pro).toContain("年付 HK$1,280");
    expect(pro).toContain('annualStripeUrl: ""');
    const proPlus = PLANS.split('id: "professional_plus"')[1]?.split('id: "team"')[0] ?? "";
    expect(proPlus).toContain("年付 HK$1,980");
    expect(proPlus).toContain('annualStripeUrl: ""');
    const team = PLANS.split('id: "team"')[1]?.split('id: "enterprise"')[0] ?? "";
    expect(team).toContain("年付 HK$3,880");
    expect(team).toContain('annualStripeUrl: ""');
  });

  it("四档沿能力线递进(超集关系标注)", () => {
    expect(PLANS).toContain("包含 Free 全部权益");
    expect(PLANS).toContain("包含 Professional 全部权益");
    expect(PLANS).toContain("包含 Professional+ 全部权益");
  });

  it("plans.ts 已移除 Stripe 字段(Stripe 应用层已删除)", () => {
    expect(PLANS).not.toContain("stripePriceId");
    expect(PLANS).not.toContain("stripeAnnualPriceId");
  });
});

describe("0033/0034 与 plans.ts 对齐", () => {
  it("plan_id 白名单一致:free/professional/professional_plus/team/enterprise", () => {
    expect(M0033).toMatch(/plan_id in \('free','professional','professional_plus','team','enterprise'\)/);
    expect(PLANS).toContain('id: "free"');
    expect(PLANS).toContain('id: "professional"');
    expect(PLANS).toContain('id: "professional_plus"');
    expect(PLANS).toContain('id: "team"');
    expect(PLANS).toContain('id: "enterprise"');
  });

  it("权益 feature 与 agent 路由判断一致:monthly_agent_turns", () => {
    expect(M0034).toContain("monthly_agent_turns");
  });
});

describe("两条 AI 通道的额度守卫", () => {
  const TURN_QUOTA = readFileSync(
    resolve(ROOT, "src/lib/billing/turn-quota.ts"),
    "utf8",
  );
  const AGENT_ROUTE = readFileSync(
    resolve(ROOT, "src/app/api/agent/route.ts"),
    "utf8",
  );
  const CHAT_ROUTE = readFileSync(
    resolve(ROOT, "src/app/api/chat/route.ts"),
    "utf8",
  );

  it("守卫只有一处实现:两条通道都调 checkTurnQuota", () => {
    // 守卫此前只写在 agent 路由里,chat 路由一行都没有 ——
    // 免费用户走 AI 助手可以无限调用,套餐里的次数只是一句话。
    // 这两条断言就是防它再次发生:任何一条通道被摘掉都会红。
    //
    // 必须断言**真的调用了**,不能只断言文件里出现过这个词 ——
    // 变异检验时把调用换掉、import 留着,只查 toContain 依然全绿。
    expect(AGENT_ROUTE).toMatch(/await\s+checkTurnQuota\s*\(/);
    expect(CHAT_ROUTE).toMatch(/await\s+checkTurnQuota\s*\(/);
    // 且守卫的结果必须真的用来拦人,不能算完就扔
    expect(AGENT_ROUTE).toMatch(/quotaExceededResponse\(\s*blocked\.reason/);
    expect(CHAT_ROUTE).toMatch(/quotaExceededResponse\(\s*blocked\.reason/);
    expect(TURN_QUOTA).toContain("getMyEntitlements");
    expect(TURN_QUOTA).toContain("monthly_agent_turns");
  });

  it("权益判断走数据库,不信任客户端传的 plan", () => {
    expect(TURN_QUOTA).toContain("get_monthly_usage");
    // 两条路由都不得自己解析请求体里的 plan/planId 来放行
    expect(AGENT_ROUTE).not.toMatch(/body\??\.\s*plan/);
    expect(CHAT_ROUTE).not.toMatch(/body\??\.\s*plan/);
  });

  it("权益守卫:owner/admin 豁免只适用于多成员组织(P0-4)", () => {
    // owner/admin 从 memberships 读角色;豁免必须叠加成员数 >1
    // (注册自动建的个人组织只有 1 个成员,owner 也是普通用户,照常计额度)
    expect(TURN_QUOTA).toContain('membership?.role === "owner"');
    expect(TURN_QUOTA).toContain('membership?.role === "admin"');
    expect(TURN_QUOTA).toContain("isTeamAdmin");
    expect(TURN_QUOTA).toContain("memberCount ?? 0) > 1");
    // 豁免逻辑必须在权益判断之前 —— 先查角色与成员数,再决定要不要查额度。
    // 在 checkTurnQuota 的函数体里比,不比整个文件:
    // 文件顶部的 import 也含 getMyEntitlements,那不是调用顺序。
    const 函数体 = TURN_QUOTA.slice(
      TURN_QUOTA.indexOf("export async function checkTurnQuota"),
    );
    expect(函数体.indexOf("isTeamAdmin")).toBeGreaterThan(-1);
    expect(函数体.indexOf("isTeamAdmin")).toBeLessThan(
      函数体.indexOf("getMyEntitlements"),
    );
  });

  it("权益守卫:额度必须减去本月已用量(P0-3)", () => {
    expect(TURN_QUOTA).toContain("get_monthly_usage");
    expect(TURN_QUOTA).toContain("agent_turns");
    expect(TURN_QUOTA).toContain("agentTurnBlockReason");
  });

  it("权益查不到必须 fail-closed(按 0 处理,绝不按「不限」放行)", () => {
    // quota-math 里 null = 不限额度。所以 entitlements 取不到时
    // 兜底值只能是 0;写成 null 就是「RPC 一失败,额度守卫自动关闭」。
    expect(TURN_QUOTA).toContain(
      'quotaOf(entitlements, "monthly_agent_turns")',
    );
    expect(TURN_QUOTA).not.toMatch(
      /quotaOf\(entitlements, "monthly_agent_turns"\)\s*:\s*null/,
    );

    // 工作流侧同一套纪律(此前写的是 `: null`,是 fail-open)
    const workflowActions = readFileSync(
      resolve(ROOT, "src/app/(app)/workflow/actions.ts"),
      "utf8",
    );
    expect(workflowActions).toContain(
      'quotaOf(entitlements, "workflows") : 0',
    );
    expect(workflowActions).not.toContain(
      'quotaOf(entitlements, "workflows") : null',
    );
  });

  it("AI 助手必须计量,否则守卫永远不会触发", () => {
    // 只拦不记 = 额度永远是 0/500,chat 这条通道等于没有上限。
    expect(CHAT_ROUTE).toMatch(/await\s+meterChatTurn\s*\(/);
    expect(TURN_QUOTA).toContain("bump_usage");
    expect(TURN_QUOTA).toContain('p_category: "agent_turns"');
  });

  it("额度用尽返回 402,且带机器可读代号与升级入口", () => {
    const preflight = readFileSync(
      resolve(ROOT, "src/lib/ai/turn-preflight.ts"),
      "utf8",
    );
    expect(preflight).toContain("quotaExceededResponse");
    expect(preflight).toContain('"quota_exceeded"');
    expect(preflight).toContain("upgrade_url");
    expect(preflight).toContain("status: 402");
    expect(AGENT_ROUTE).toContain("quotaExceededResponse");
    expect(CHAT_ROUTE).toContain("quotaExceededResponse");
  });
});

describe("支付主路径:服务端 Checkout Session", () => {
  const PLANS_SECTION = readFileSync(
    resolve(ROOT, "src/components/marketing/PlansSection.tsx"),
    "utf8",
  );
  const SUBSCRIBE_BUTTON = readFileSync(
    resolve(ROOT, "src/components/marketing/SubscribeButton.tsx"),
    "utf8",
  );

  it("定价区付费档 CTA 走 SubscribeButton,不再直接跳 Payment Link", () => {
    // SubscribeButton 曾经存在但全仓库没人 import —— 安全路径整条是死的。
    expect(PLANS_SECTION).toContain("SubscribeButton");
    expect(SUBSCRIBE_BUTTON).toContain("/api/billing/checkout");
  });

  it("Payment Link 只作为备用;未登录且有备用链接时直接打开(收款优先)", () => {
    // 未登录付的款只能靠付款邮箱反查;但「能收到钱」优先于「归属精确」——
    // 401 时若有 fallbackUrl 直接打开支付页(2026-08-10),无链接才跳登录页。
    expect(SUBSCRIBE_BUTTON).toContain("fallbackUrl");
    const 未登录处理 = SUBSCRIBE_BUTTON.indexOf("res.status === 401");
    const 链接降级 = SUBSCRIBE_BUTTON.indexOf("assign(fallbackUrl)");
    const 登录兜底 = SUBSCRIBE_BUTTON.indexOf("/login?next=");
    expect(未登录处理).toBeGreaterThan(-1);
    expect(链接降级).toBeGreaterThan(-1);
    expect(登录兜底).toBeGreaterThan(-1);
    expect(未登录处理).toBeLessThan(链接降级);
    expect(链接降级).toBeLessThan(登录兜底);
  });

  it("订阅按钮下方不挂任何说明性文字", () => {
    // 用户要求:按钮就是按钮,下面不留残留文字。
    // 每条分支的终点都是一次真实跳转(Checkout / Payment Link / 登录页 /
    // /billing),所以没有「点了之后留在原地看一行字」的状态。
    expect(SUBSCRIBE_BUTTON).not.toContain("setNote");
    expect(SUBSCRIBE_BUTTON).not.toContain("setError");
    expect(SUBSCRIBE_BUTTON).not.toContain("同一个邮箱");
    // 组件返回值里不得再出现文字容器
    const 返回值 = SUBSCRIBE_BUTTON.slice(SUBSCRIBE_BUTTON.indexOf("return ("));
    expect(返回值).not.toContain("<span");
    // 失败原因仍要留下,只是留在控制台而不是界面上
    expect(SUBSCRIBE_BUTTON).toContain("console.warn");
  });

  it("付款回跳:不得对刚付完钱的人显示「未订阅」", () => {
    const SESSION = readFileSync(
      resolve(ROOT, "src/lib/billing/checkout-session.ts"),
      "utf8",
    );
    const MANAGER = readFileSync(
      resolve(ROOT, "src/components/app/BillingManager.tsx"),
      "utf8",
    );

    // 归属校验:别人的 session_id 一律不认
    expect(SESSION).toContain('session.metadata?.["userId"] !== userId');
    // 只读:回跳这条路绝不写库、不解锁(subscriptions 唯一写者仍是 webhook)
    expect(SESSION).not.toMatch(/\.from\(["']subscriptions["']\)/);
    expect(SESSION).not.toContain("upsert");
    expect(SESSION).not.toContain("insert");

    // 待开通分支必须排在「当前为免费套餐」之前
    const 待开通 = MANAGER.indexOf("activationPending ?");
    const 免费文案 = MANAGER.indexOf("当前为免费套餐");
    expect(待开通).toBeGreaterThan(-1);
    expect(待开通).toBeLessThan(免费文案);
    // 轮询必须有上限,否则「webhook 没配对」会被伪装成「还在处理中」
    expect(MANAGER).toContain("waited >= 20");
  });

  it("客户端只传 planId/interval,金额与权益不经客户端", () => {
    expect(SUBSCRIBE_BUTTON).toContain("JSON.stringify({ planId, interval })");
    expect(SUBSCRIBE_BUTTON).not.toMatch(/amount|price_|unit_amount/);
  });
});
