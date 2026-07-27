/**
 * 套餐定义。
 *
 * 三档套餐名称来自产品需求第五章:Free / Professional / Enterprise。
 *
 * 关于价格:除 Free 的 ¥0 是确定事实外,其余价格必须来自 Stripe 中真实配置的
 * Price 对象,不得在代码里写死。当前 Stripe 密钥在 Vercel 被标记为 Sensitive、
 * 无法读取,因此价格标记为「待定」并禁用购买入口 —— 在公开页面展示一个
 * 未经核实的价格,属于伪造商业信息。
 *
 * Phase 6 接通 Stripe 后,价格改为从 Stripe API 读取真实 Price,并填入 stripePriceId。
 */

export type PlanId = "free" | "professional" | "enterprise";

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  /** 已确定的价格展示文案;undefined 表示尚未从 Stripe 取到真实价格 */
  readonly price: string | undefined;
  readonly period: string;
  readonly features: readonly string[];
  readonly highlighted: boolean;
  /** Stripe 中对应的 Price ID。Phase 6 接通后填入。 */
  readonly stripePriceId: string | undefined;
}

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    price: "¥0",
    period: "月",
    features: [
      "1 个工作流",
      "基础知识库",
      "AI 记忆全量可见可删除",
      "使用您自己的模型密钥",
    ],
    highlighted: false,
    stripePriceId: undefined,
  },
  {
    id: "professional",
    name: "Professional",
    price: undefined,
    period: "月",
    features: [
      "多个工作流与自定义 Agent",
      "文件解析与向量检索",
      "工作流执行历史与审计",
      "更高的用量额度",
    ],
    highlighted: true,
    stripePriceId: undefined,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: undefined,
    period: "月",
    features: [
      "组织、成员与角色权限",
      "私有模型网关接入",
      "完整审计日志",
      "数据隔离与合规支持",
    ],
    highlighted: false,
    stripePriceId: undefined,
  },
];

/** 价格是否已从 Stripe 取到真实值 */
export function hasVerifiedPrice(plan: Plan): boolean {
  return plan.price !== undefined;
}
