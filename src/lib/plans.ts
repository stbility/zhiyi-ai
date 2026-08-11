/**
 * 套餐定义。
 *
 * 五档套餐:Free / Professional / Professional+ / Team / Enterprise。
 *
 *   定价决策(2026-08-11,全球华人市场策略):
 *   主体:香港公司,结算货币港币 HKD。
 *   Free       HK$0/月
 *   Professional  HK$128/月 · HK$1,280/年
 *   Professional+ HK$198/月 · HK$1,980/年
 *   Team        HK$388/月 · HK$3,880/年
 *   Enterprise  自定义报价
 *   年付按行业惯例「两个月免费」: Professional 年付省 HK$256,
 *   Professional+ 年付省 HK$396,Team 年付省 HK$776。
 *
 * ── features 数组的口径 ──────────────────────────────────────────────
 * 这里是**展示层**,写什么用户就信什么,所以每一条都必须标明它到底
 * 落到哪一层。判断层(entitlements 表)当前只定义两项:
 *
 *   [已实现·权益层强制]  workflows(数量上限)
 *   [已实现·权益层强制]  monthly_agent_turns(每月 AI 调用次数)
 *
 * 其余能力在权益表里**没有任何一行** —— 也就是说 free 和 enterprise
 * 拿到的是同一套,套餐之间不产生差别。它们要么尚未交付,要么已交付但
 * 不按套餐区分。所以下面逐条标注,标注就是承诺边界:
 *
 *   [已交付·不分档]  各档都能用,不构成付费理由
 *   [待实现]          尚未交付,不得在对外文案里表述成「订阅即可获得」
 *
 * 加新条目时必须一并标注。没标注的条目视为对用户的虚假承诺。
 */

export type PlanId = "free" | "professional" | "professional_plus" | "team" | "enterprise";

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
    price: "HK$0",
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
    price: "HK$128",
    period: "月",
    // 旧账号 Payment Link 已于 2026-08-10 随账号删除失效 —— 清空防死链;
    // 新账号重建后填入新链接(checkout 503 时降级用)。
    stripeUrl: "",
    annualPrice: "HK$1,280/年",
    annualNote: "年付约省 HK$256",
    annualStripeUrl: "",
    features: [
      "5 个工作流", // [已实现·权益层强制] entitlements.workflows = 5
      // [待实现] 向量检索需 EMBEDDINGS_API_URL/KEY,当前生产未配置;
      // 且权益表无对应行 —— 免费档同样不受限。不得表述为付费专属。
      "文件解析与向量检索",
      "工作流执行历史与追溯", // [已交付·不分档]
      "每月 500 次 Agent 额度", // [已实现·权益层强制] monthly_agent_turns = 500
      "包含 Free 全部权益", // [结构性] 四档为超集关系
    ],
    highlighted: true,
  },
  {
    id: "professional_plus",
    name: "Professional+ 专业增强版",
    price: "HK$198",
    period: "月",
    stripeUrl: "",
    annualPrice: "HK$1,980/年",
    annualNote: "年付约省 HK$396",
    annualStripeUrl: "",
    features: [
      "10 个工作流", // [已实现·权益层强制] entitlements.workflows = 10
      // [待实现] 向量检索未实现,各档无差别对待。
      "文件解析与向量检索", // [待实现]
      "工作流执行历史与追溯", // [已交付·不分档]
      "每月 2,000 次 Agent 额度", // [已实现·权益层强制] monthly_agent_turns = 2000
      "包含 Professional 全部权益", // [结构性] 四档为超集关系
    ],
    highlighted: false,
  },
  {
    id: "team",
    name: "Team 团队版",
    price: "HK$388",
    period: "月",
    stripeUrl: "",
    annualPrice: "HK$3,880/年",
    annualNote: "年付约省 HK$776",
    annualStripeUrl: "",
    features: [
      "30 个工作流", // [已实现·权益层强制] entitlements.workflows = 30
      // [待实现] 成员管理尚未交付完整功能。
      "组织、成员与角色权限", // [待实现]
      "组织知识库与团队级检索", // [待实现] 依赖成员管理
      "工作流执行历史与追溯", // [已交付·不分档]
      "每月 5,000 次 Agent 额度", // [已实现·权益层强制] monthly_agent_turns = 5000
      "包含 Professional+ 全部权益", // [结构性] 四档为超集关系
    ],
    highlighted: false,
  },
  {
    id: "enterprise",
    name: "Enterprise 企业版",
    price: "自定义报价",
    period: "",
    // 旧账号 Payment Link 已随账号删除失效(2026-08-10),清空防死链。
    stripeUrl: "",
    annualPrice: undefined,
    annualNote: undefined,
    annualStripeUrl: undefined,
    features: [
      // [待实现] 成员管理未交付完整功能。
      "组织、成员与角色权限", // [待实现]
      "组织知识库与团队级检索", // [待实现]
      "私有模型网关接入", // [待实现] 权益表无对应行,各档无差别
      "数据隔离与合规支持", // [待实现] 当前仅 RLS 行级隔离,无独立合规交付物
      "SLA 与专属支持", // [待实现] 无监控/告警/备份回滚支撑,无法承诺 SLA
      "工作流数不限", // [已实现·权益层强制] entitlements.workflows = null
      "每月 5,000 次 Agent 额度", // [已实现·权益层强制] monthly_agent_turns = 5000
      "包含 Team 全部权益", // [结构性] 四档为超集关系
    ],
    highlighted: false,
  },
];
