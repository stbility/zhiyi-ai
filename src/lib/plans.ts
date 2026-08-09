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
 * 支付路径(2026-08-09 修正):**服务端 Checkout Session 为主**。
 * 付费档 CTA 走 SubscribeButton → /api/billing/checkout,服务端把 userId 写进
 * session/subscription 的 metadata,webhook 据此精确归户。
 * stripeUrl / annualStripeUrl 退为**备用**:仅当 checkout 确实不可用
 * (Price ID 未配置、Stripe 目录查不到价格)时降级,且会明确提示用户
 * 必须用同一个邮箱付款 —— 那条路只能靠 customer.email 反查,归不了户就是收了钱没交付。
 *
 * ── features 数组的口径(2026-08-09 起) ────────────────────────────
 * 这里是**展示层**,写什么用户就信什么,所以每一条都必须标明它到底
 * 落到哪一层。判断层(0034 entitlements 表)当前只定义两项:
 *
 *   [已实现·权益层强制]  workflows(数量上限)
 *   [已实现·权益层强制]  monthly_agent_turns(每月 AI 调用次数,
 *                        AI 助手与智能体两条通道共用同一份额度)
 *
 * 其余能力在权益表里**没有任何一行** —— 也就是说 free 和 enterprise
 * 拿到的是同一套,套餐之间不产生差别。它们要么尚未交付,要么已交付但
 * 不按套餐区分。所以下面逐条标注,标注就是承诺边界:
 *
 *   [已交付·不分档]  各档都能用,不构成付费理由
 *   [待实现]          尚未交付,写在这里只能作为路线图,
 *                     **不得**在对外文案里表述成「订阅即可获得」
 *
 * 加新条目时必须一并标注。没标注的条目视为对用户的虚假承诺。
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
      "1 个工作流", // [已实现·权益层强制] entitlements.workflows = 1
      "基础知识库", // [已交付·不分档] 各档相同,不构成付费理由
      "AI 记忆全量可见可删除", // [已交付·不分档]
      "使用您自己的模型密钥", // [已交付·不分档] BYOK 各档相同
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
      "多个工作流与自定义 Agent", // [已实现·权益层强制] entitlements.workflows = 5
      // [待实现] 向量检索需 EMBEDDINGS_API_URL/KEY,当前生产未配置;
      // 且权益表无对应行 —— 免费档同样不受限。不得表述为付费专属。
      "文件解析与向量检索",
      "工作流执行历史与追溯", // [已交付·不分档]
      "每月 500 次 Agent 额度", // [已实现·权益层强制] monthly_agent_turns = 500
      "包含 Free 全部权益", // [结构性] 三档为超集关系
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
      // [待实现] 成员管理未交付(/status 自陈:「组织」外壳套「个人」实质,
      // 页面固定取第一个组织);完整审计日志同样未交付。权益表无对应行。
      "组织、成员与角色权限",
      "组织知识库与团队级检索", // [待实现] 团队级检索依赖成员管理与向量检索
      "私有模型网关接入", // [待实现] 权益表无对应行,各档无差别
      "数据隔离与合规支持", // [待实现] 当前仅 RLS 行级隔离,无独立合规交付物
      "SLA 与专属支持", // [待实现] 无监控/告警/备份回滚支撑,无法承诺 SLA
      "每月 5,000 次 Agent 额度", // [已实现·权益层强制] monthly_agent_turns = 5000
      "包含 Professional 全部权益", // [结构性] 三档为超集关系
    ],
    highlighted: false,
  },
];
