/**
 * 套餐定义。
 *
 * 三档套餐名称来自产品需求第五章:Free / Professional / Enterprise。
 *
 *   定价决策(2026-08-07,全球华人市场策略):
 *   主体:香港公司,结算货币港币 HKD。
 *   Professional HK49/月 · Enterprise HK229/月(替代 ¥39/¥199)。
 *   年付按行业惯例「两个月免费」:Pro HK490/年 · Ent HK2,290/年。
 *   三档沿同一能力线递进(超集关系,类比 Sensei AI):每档包含低一档全部权益。
 *   完整策略见 /Users/kuanxu/zhiyi-ai-market-monetization-strategy.md。
 *
 * 价格标准格式:HK49 / HK229(不带货币符号 $,2026-08-08 定)。
 *
 * 说明:价格文案为产品决策展示值。
 *
 * 支付路径(2026-08-08 终态):**Payment Link 为主**(stripeUrl / annualStripeUrl)。
 * 用户偏好 Payment Link —— checkout 路由反复卡在环境变量/密钥,而 Payment Link
 * 是 Stripe 原生可用的。归属靠两层兜底:① 前端登录态给链接拼
 * `?prefilled_email=`(webhook 按 customer.email 反查 app 用户)② webhook 三层
 * 归属(metadata.userId → stripe_customers 映射 → email 反查)。
 * /api/billing/checkout 路由保留作后备(checkout 绑定 userId 更直接)。
 */

export type PlanId = "free" | "professional" | "enterprise";

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  /** 已确定的价格展示文案;undefined 表示尚未从 Stripe 取到真实价格 */
  readonly price: string | undefined;
  readonly period: string;
  /** 月付 Payment Link(主支付路径,登录态由前端拼 prefilled_email 绑定) */
  readonly stripeUrl: string | undefined;
  /** 年付价格展示文案(两个月免费惯例);undefined 表示年付未开通 */
  readonly annualPrice: string | undefined;
  /** 年付说明文案,展示「省多少」增强感知 */
  readonly annualNote: string | undefined;
  /** 年付 Payment Link */
  readonly annualStripeUrl: string | undefined;
  readonly features: readonly string[];
  readonly highlighted: boolean;
}

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    price: "HK0",
    period: "月",
    stripeUrl: undefined,
    annualPrice: undefined,
    annualNote: undefined,
    annualStripeUrl: undefined,
    features: [
      "1 个工作流",
      "基础知识库",
      "AI 记忆全量可见可删除",
      "使用您自己的模型密钥",
    ],
    highlighted: false,
  },
  {
    id: "professional",
    name: "Professional 专业版",
    price: "HK49",
    period: "月",
    stripeUrl: "https://buy.stripe.com/28E4gB8S35O54ga2JCfbq02",
    annualPrice: "HK490/年",
    annualNote: "年付 HK490,约省 2 个月",
    annualStripeUrl: "https://buy.stripe.com/7sYbJ30lx0tL3c6ckcfbq04",
    features: [
      "多个工作流与自定义 Agent",
      "文件解析与向量检索",
      "工作流执行历史与追溯",
      "每月 500 次 Agent 额度",
      "包含 Free 全部权益",
    ],
    highlighted: true,
  },
  {
    id: "enterprise",
    name: "Enterprise 企业版",
    price: "HK229",
    period: "月",
    stripeUrl: "https://buy.stripe.com/fZueVffgr2BT5ke1Fyfbq03",
    annualPrice: "HK2,290/年",
    annualNote: "年付 HK2,290,约省 2 个月",
    annualStripeUrl: "https://buy.stripe.com/9B68wR5FR5O59Au4RKfbq05",
    features: [
      "组织、成员与角色权限",
      "组织知识库与团队级检索",
      "私有模型网关接入",
      "完整审计日志",
      "数据隔离与合规支持",
      "SLA 与专属支持",
      "每月 5,000 次 Agent 额度",
      "包含 Professional 全部权益",
    ],
    highlighted: false,
  },
];
