/**
 * 套餐与 Stripe Price ID 映射。
 *
 * Price ID 来源: Stripe Dashboard → Products → 各产品 → Pricing tab → Price ID。
 * 格式: price_xxx (Test mode) 或 price_xxx (Live mode)。
 *
 * STRIPE_PRICE_* 环境变量说明(来自 .env.example):
 *   STRIPE_PRICE_PRO_MONTH      = price_xxx  Professional 月付
 *   STRIPE_PRICE_PRO_YEAR       = price_xxx  Professional 年付
 *   STRIPE_PRICE_ENT_MONTH      = price_xxx  Enterprise 月付
 *   STRIPE_PRICE_ENT_YEAR       = price_xxx  Enterprise 年付
 *
 * Payment Link 来源: Stripe Dashboard → Products → Payment Links。
 * STRIPE_PAYMENT_LINK_PRO_MONTH = https://buy.stripe.com/xxx
 * STRIPE_PAYMENT_LINK_PRO_YEAR  = https://buy.stripe.com/xxx
 * STRIPE_PAYMENT_LINK_ENT_MONTH = https://buy.stripe.com/xxx
 * STRIPE_PAYMENT_LINK_ENT_YEAR  = https://buy.stripe.com/xxx
 *
 * 注意: Vercel 集成仅注入 STRIPE_SECRET_KEY / NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY / STRIPE_MCP_KEY。
 * Price ID 和 Payment Link 属于业务层配置,需要你填入 Vercel Environment Variables。
 */

export type PlanId = "free" | "professional" | "enterprise";

export interface Plan {
  id: PlanId;
  name: string;
  /** 价格展示文案,undefined 表示尚未配置 */
  price: string | undefined;
  period: string;
  annualPrice: string | undefined;
  annualNote: string | undefined;
  features: readonly string[];
  highlighted: boolean;
  /** Stripe Price ID (env: STRIPE_PRICE_PRO_MONTH 等) */
  priceIdMonth: string | undefined;
  priceIdYear: string | undefined;
  /** Stripe Payment Link URL */
  paymentLinkMonth: string | undefined;
  paymentLinkYear: string | undefined;
}

const STRIPE_PRICE_PRO_MONTH = process.env.STRIPE_PRICE_PRO_MONTH;
const STRIPE_PRICE_PRO_YEAR = process.env.STRIPE_PRICE_PRO_YEAR;
const STRIPE_PRICE_ENT_MONTH = process.env.STRIPE_PRICE_ENT_MONTH;
const STRIPE_PRICE_ENT_YEAR = process.env.STRIPE_PRICE_ENT_YEAR;

const STRIPE_PAYMENT_LINK_PRO_MONTH = process.env.STRIPE_PAYMENT_LINK_PRO_MONTH;
const STRIPE_PAYMENT_LINK_PRO_YEAR = process.env.STRIPE_PAYMENT_LINK_PRO_YEAR;
const STRIPE_PAYMENT_LINK_ENT_MONTH = process.env.STRIPE_PAYMENT_LINK_ENT_MONTH;
const STRIPE_PAYMENT_LINK_ENT_YEAR = process.env.STRIPE_PAYMENT_LINK_ENT_YEAR;

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    price: "HK$0",
    period: "月",
    annualPrice: undefined,
    annualNote: undefined,
    features: [
      "1 个工作流",
      "基础知识库",
      "AI 记忆全量可见可删除",
      "使用您自己的模型密钥",
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
    price: "HK$49/月",
    period: "月",
    annualPrice: "HK$490/年",
    annualNote: "年付约省 2 个月",
    features: [
      "多个工作流与自定义 Agent",
      "文件解析与向量检索",
      "工作流执行历史与追溯",
      "更高的用量额度",
      "包含 Free 全部权益",
    ],
    highlighted: true,
    priceIdMonth: STRIPE_PRICE_PRO_MONTH,
    priceIdYear: STRIPE_PRICE_PRO_YEAR,
    paymentLinkMonth: STRIPE_PAYMENT_LINK_PRO_MONTH,
    paymentLinkYear: STRIPE_PAYMENT_LINK_PRO_YEAR,
  },
  {
    id: "enterprise",
    name: "Enterprise 企业版",
    price: "HK$229/月",
    period: "月",
    annualPrice: "HK$2,290/年",
    annualNote: "年付约省 2 个月",
    features: [
      "组织、成员与角色权限",
      "组织知识库与团队级检索",
      "私有模型网关接入",
      "完整审计日志",
      "数据隔离与合规支持",
      "SLA 与专属支持",
      "包含 Professional 全部权益",
    ],
    highlighted: false,
    priceIdMonth: STRIPE_PRICE_ENT_MONTH,
    priceIdYear: STRIPE_PRICE_ENT_YEAR,
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
