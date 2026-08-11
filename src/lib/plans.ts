/**
 * 套餐与 Stripe Price ID 映射。
 *
 * Price ID 来源: Stripe Dashboard → Products → 各产品 → Pricing tab → Price ID。
 * Payment Link 来源: Stripe Dashboard → Products → Payment Links。
 *
 * 环境变量说明:
 *   STRIPE_PRICE_PRO_MONTH           = price_xxx  Professional 月付
 *   STRIPE_PRICE_PRO_YEAR            = price_xxx  Professional 年付
 *   STRIPE_PRICE_PRO_PLUS_MONTH     = price_xxx  Professional+ 月付
 *   STRIPE_PRICE_PRO_PLUS_YEAR      = price_xxx  Professional+ 年付
 *   STRIPE_PRICE_TEAM_MONTH         = price_xxx  Team 月付
 *   STRIPE_PRICE_TEAM_YEAR          = price_xxx  Team 年付
 *   STRIPE_PAYMENT_LINK_PRO_MONTH    = https://buy.stripe.com/xxx  Professional 月付
 *   STRIPE_PAYMENT_LINK_PRO_YEAR     = https://buy.stripe.com/xxx  Professional 年付
 *   STRIPE_PAYMENT_LINK_PRO_PLUS_MONTH  = https://buy.stripe.com/xxx  Professional+ 月付
 *   STRIPE_PAYMENT_LINK_PRO_PLUS_YEAR   = https://buy.stripe.com/xxx  Professional+ 年付
 *   STRIPE_PAYMENT_LINK_ENT_MONTH   = https://buy.stripe.com/xxx  Enterprise 月付
 *   STRIPE_PAYMENT_LINK_ENT_YEAR    = https://buy.stripe.com/xxx  Enterprise 年付
 *   STRIPE_PAYMENT_LINK_TEAM_MONTH  = https://buy.stripe.com/xxx  Team 月付
 *   STRIPE_PAYMENT_LINK_TEAM_YEAR   = https://buy.stripe.com/xxx  Team 年付
 *
 * 【Agent 运行计次定义】
 * 用户主动启动一次 Agent 任务计为一次运行。任务内部的模型调用、
 * 工具调用、系统重试和检查点续跑不重复计次。因平台故障且未产生
 * 有效结果的运行自动返还额度。
 */

export type PlanId = "free" | "professional" | "professional_plus" | "team" | "enterprise";

export interface Plan {
  id: PlanId;
  name: string;
  /** 价格展示文案，undefined 表示未配置或自定义定价 */
  price: string | undefined;
  period: string;
  annualPrice: string | undefined;
  annualNote: string | undefined;
  features: readonly string[];
  highlighted: boolean;
  /** Stripe Price ID（env: STRIPE_PRICE_*_MONTH / _YEAR） */
  priceIdMonth: string | undefined;
  priceIdYear: string | undefined;
  /** Stripe Payment Link URL */
  paymentLinkMonth: string | undefined;
  paymentLinkYear: string | undefined;
}

const STRIPE_PRICE_PRO_MONTH = process.env.STRIPE_PRICE_PRO_MONTH;
const STRIPE_PRICE_PRO_YEAR = process.env.STRIPE_PRICE_PRO_YEAR;
const STRIPE_PRICE_PRO_PLUS_MONTH = process.env.STRIPE_PRICE_PRO_PLUS_MONTH;
const STRIPE_PRICE_PRO_PLUS_YEAR = process.env.STRIPE_PRICE_PRO_PLUS_YEAR;
const STRIPE_PRICE_TEAM_MONTH = process.env.STRIPE_PRICE_TEAM_MONTH;
const STRIPE_PRICE_TEAM_YEAR = process.env.STRIPE_PRICE_TEAM_YEAR;

const STRIPE_PAYMENT_LINK_PRO_MONTH = process.env.STRIPE_PAYMENT_LINK_PRO_MONTH;
const STRIPE_PAYMENT_LINK_PRO_YEAR = process.env.STRIPE_PAYMENT_LINK_PRO_YEAR;
const STRIPE_PAYMENT_LINK_PRO_PLUS_MONTH = process.env.STRIPE_PAYMENT_LINK_PRO_PLUS_MONTH;
const STRIPE_PAYMENT_LINK_PRO_PLUS_YEAR = process.env.STRIPE_PAYMENT_LINK_PRO_PLUS_YEAR;
const STRIPE_PAYMENT_LINK_ENT_MONTH = process.env.STRIPE_PAYMENT_LINK_ENT_MONTH;
const STRIPE_PAYMENT_LINK_ENT_YEAR = process.env.STRIPE_PAYMENT_LINK_ENT_YEAR;
const STRIPE_PAYMENT_LINK_TEAM_MONTH = process.env.STRIPE_PAYMENT_LINK_TEAM_MONTH;
const STRIPE_PAYMENT_LINK_TEAM_YEAR = process.env.STRIPE_PAYMENT_LINK_TEAM_YEAR;

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    price: "HK$0/月",
    period: "月",
    annualPrice: undefined,
    annualNote: undefined,
    features: [
      "1 个启用中的工作流",
      "每月 100 次标准 Agent 运行",
      "AI 记忆可查看、确认和删除",
      "支持使用自己的模型密钥",
      "1 个并发任务",
    ],
    highlighted: false,
    priceIdMonth: undefined,
    priceIdYear: undefined,
    paymentLinkMonth: undefined,
    paymentLinkYear: undefined,
  },
  {
    id: "professional",
    name: "Professional 专业版",
    price: "HK$128/月",
    period: "月",
    annualPrice: "HK$1,280/年",
    annualNote: "年付约省 2 个月",
    features: [
      "5 个启用中的工作流",
      "每月 2,000 次标准 Agent 运行",
      "个人知识库与文件解析",
      "90 天执行历史",
      "2 个并发任务",
      "优先邮件支持",
      "包含 Free 全部权益",
    ],
    highlighted: true,
    priceIdMonth: STRIPE_PRICE_PRO_MONTH,
    priceIdYear: STRIPE_PRICE_PRO_YEAR,
    paymentLinkMonth: STRIPE_PAYMENT_LINK_PRO_MONTH,
    paymentLinkYear: STRIPE_PAYMENT_LINK_PRO_YEAR,
  },
  {
    id: "professional_plus",
    name: "Professional 进阶版",
    price: "HK$198/月",
    period: "月",
    annualPrice: "HK$1,980/年",
    annualNote: "年付约省 2 个月",
    features: [
      "10 个启用中的工作流",
      "每月 4,000 次标准 Agent 运行",
      "更大的知识库容量",
      "365 天执行历史",
      "5 个并发任务",
      "评测、反馈与数据导出",
      "优先任务队列",
      "包含 Professional 全部权益",
    ],
    highlighted: false,
    priceIdMonth: STRIPE_PRICE_PRO_PLUS_MONTH,
    priceIdYear: STRIPE_PRICE_PRO_PLUS_YEAR,
    paymentLinkMonth: STRIPE_PAYMENT_LINK_PRO_PLUS_MONTH,
    paymentLinkYear: STRIPE_PAYMENT_LINK_PRO_PLUS_YEAR,
  },
  {
    id: "team",
    name: "Team 团队版",
    price: "HK$388/月",
    period: "月",
    annualPrice: "HK$3,880/年",
    annualNote: "包含 3 名成员，年付约省 2 个月",
    features: [
      "组织、成员与角色权限",
      "组织知识库与团队检索",
      "完整审计日志",
      "每月 10,000 次标准 Agent 运行",
      "额外成员及额度可加购",
      "优先支持",
    ],
    highlighted: false,
    priceIdMonth: STRIPE_PRICE_TEAM_MONTH,
    priceIdYear: STRIPE_PRICE_TEAM_YEAR,
    paymentLinkMonth: STRIPE_PAYMENT_LINK_TEAM_MONTH,
    paymentLinkYear: STRIPE_PAYMENT_LINK_TEAM_YEAR,
  },
  {
    id: "enterprise",
    name: "Enterprise 企业版",
    price: undefined, // 自定义报价，不展示固定价格
    period: "月",
    annualPrice: undefined,
    annualNote: undefined,
    features: [
      "SSO/SAML 与自动成员管理",
      "私有模型网关或专属部署",
      "自定义使用额度和并发",
      "数据保留与审计导出",
      "安全及合规评审",
      "正式 SLA",
      "专属技术支持",
    ],
    highlighted: false,
    priceIdMonth: undefined,
    priceIdYear: undefined,
    paymentLinkMonth: STRIPE_PAYMENT_LINK_ENT_MONTH,
    paymentLinkYear: STRIPE_PAYMENT_LINK_ENT_YEAR,
  },
];

/** 根据 Price ID 找到对应 Plan。用于 webhook 解析 price → plan。 */
export function getPlanByPriceId(priceId: string): Plan | undefined {
  return PLANS.find(
    (p) => p.priceIdMonth === priceId || p.priceIdYear === priceId,
  );
}

/** 根据 Payment Link URL 找到对应 Plan。用于 webhook 解析 link → plan。 */
export function getPlanByPaymentLink(paymentLink: string): Plan | undefined {
  return PLANS.find(
    (p) =>
      p.paymentLinkMonth === paymentLink ||
      p.paymentLinkYear === paymentLink,
  );
}
