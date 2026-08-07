/**
 * 套餐定义。
 *
 * 三档套餐名称来自产品需求第五章:Free / Professional / Enterprise。
 *
 * 定价决策(2026-08-07,全球华人市场策略):
 *   主体:香港公司,结算货币港币 HKD。
 *   Professional HK$49/月 · Enterprise HK$229/月(替代 ¥39/¥199)。
 *   年付按行业惯例「两个月免费」:Pro HK$490/年 · Ent HK$2,290/年。
 *   三档沿同一能力线递进(超集关系,类比 Sensei AI):每档包含低一档全部权益。
 *   完整策略见 /Users/kuanxu/zhiyi-ai-market-monetization-strategy.md。
 *
 * 关于价格:除 Free 的 HK$0 是确定事实外,其余价格必须来自 Stripe 中真实配置的
 * Price 对象,不得在代码里写死。当前 Stripe 密钥在 Vercel 被标记为 Sensitive、
 * 无法读取,因此价格标记为「待定」并禁用购买入口 —— 在公开页面展示一个
 * 未经核实的价格,属于伪造商业信息。
 *
 * Phase 6 接通 Stripe 后,价格改为从 Stripe API 读取真实 Price,并填入 stripePriceId。
 * 产品决策价(HK$49/HK$229)与展示文案在此定义,最终以 Stripe Price 为准。
 */

export type PlanId = "free" | "professional" | "enterprise";

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  /** 已确定的价格展示文案;undefined 表示尚未从 Stripe 取到真实价格 */
  readonly price: string | undefined;
  readonly period: string;
  /** 年付价格展示文案(两个月免费惯例);undefined 表示年付未开通 */
  readonly annualPrice: string | undefined;
  /** 年付说明文案,展示「省多少」增强感知 */
  readonly annualNote: string | undefined;
  readonly features: readonly string[];
  readonly highlighted: boolean;
  /** Stripe 中对应的月付 Price ID。Phase 6 接通后填入。 */
  readonly stripePriceId: string | undefined;
  /** Stripe 中对应的年付 Price ID。Phase 6 接通后填入。 */
  readonly stripeAnnualPriceId: string | undefined;
}

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
    stripePriceId: undefined,
    stripeAnnualPriceId: undefined,
  },
  {
    id: "professional",
    name: "Professional 专业版",
    price: undefined,
    period: "月",
    annualPrice: undefined,
    annualNote: "年付 HK$490,约省 2 个月",
    features: [
      "多个工作流与自定义 Agent",
      "文件解析与向量检索",
      "工作流执行历史与追溯",
      "更高的用量额度",
      "包含 Free 全部权益",
    ],
    highlighted: true,
    stripePriceId: undefined,
    stripeAnnualPriceId: undefined,
  },
  {
    id: "enterprise",
    name: "Enterprise 企业版",
    price: undefined,
    period: "月",
    annualPrice: undefined,
    annualNote: "年付 HK$2,290,约省 2 个月",
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
    stripePriceId: undefined,
    stripeAnnualPriceId: undefined,
  },
];
