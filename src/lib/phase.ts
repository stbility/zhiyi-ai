/**
 * 当前交付阶段。
 *
 * 单点维护,避免页面文案与实际进度脱节。产品对外宣称的进度必须与真实进度一致。
 *
 * 「一致」是双向的。这里曾长期停留在 Phase 1 / productCapabilitiesShipped: false,
 * 而实际上模型网关、智能体循环、工作区、联网检索都已经在生产上跑起来了 ——
 * 状态页仍向用户显示「产品能力尚未实现」。方向虽然是保守的,但同样是不实:
 * 一个把「不得伪装为已接通」写进红线的项目,不该反过来低报自己的能力。
 * 用户据此判断能不能用,低报会让他不去用本来可用的东西。
 */
export const CURRENT_PHASE = {
  id: "4",
  label: "Phase 4(智能体与工作流,进行中)",
  /**
   * 产品能力(需求三至六章)是否已经开始交付。
   *
   * 现在为 true,依据是这些已经在生产上真实可用:
   *   · 模型网关与服务商注册表(多协议、跨厂商降级、真实调用验证)
   *   · 智能体循环与文件工具(产物写入工作区,带步数/时间/失败三重护栏)
   *   · 联网检索(Tavily,强制标注来源)
   *   · 项目附件跨轮保留与上下文预算装配
   *
   * 仍未交付、不得对外宣称的:工作流状态机、后台 Worker、
   * 知识库与 RAG、长期记忆、订阅与计费、成员管理。
   */
  productCapabilitiesShipped: true,
} as const;

/** 一个阶段的真实状态 */
export interface PhaseStatus {
  readonly id: string;
  readonly label: string;
  readonly state: "done" | "partial" | "todo";
  /** state 为 partial 时必须写清缺什么 —— 只说「进行中」等于没说 */
  readonly missing?: string;
}

/**
 * 各阶段的真实状态。状态页据此逐条展示,而不是笼统给一句「已交付/未交付」。
 *
 * 这份清单必须对照代码核对后再改,不能凭印象。上一次核对:2026-08-02,
 * 依据是 src/ 下实际存在的模块与生产库里跑通的链路。
 */
export const PHASE_STATUS: readonly PhaseStatus[] = [
  { id: "0", label: "仓库审计与差距报告", state: "done" },
  { id: "0.5", label: "工程地基与设计系统 token 移植", state: "done" },
  { id: "0.6", label: "设计系统组件移植为 TSX + Tailwind", state: "done" },
  { id: "1", label: "数据库 Schema、迁移、RLS、Supabase 认证", state: "done" },
  {
    id: "2",
    label: "组织、成员、角色权限、审计日志",
    state: "partial",
    missing:
      "成员管理未交付;当前是「组织」外壳套「个人」实质,页面固定取第一个组织",
  },
  {
    id: "3",
    label: "Provider/Model Registry、AI Gateway、Adapter、模型服务设置页",
    state: "done",
  },
  {
    id: "4",
    label: "Tool Registry、Agent、工作流状态机、Worker",
    state: "partial",
    missing:
      "工具注册与智能体循环已完成;续跑(检查点摘要恢复,突破 300s 上限)已实现;工作流已上线(0036:10 态状态机 + 定义/步骤编辑 + 同步执行,单次最多 5 步,运行历史留痕);后台 Worker 排队执行与人工闸门(等待输入/等待确认)后续上线",
  },
  {
    id: "5",
    label: "文件上传、解析、RAG、长期记忆",
    state: "partial",
    missing:
      "文件夹上传、跨轮保留、上下文预算已完成;记忆沉淀闭环已实现(0028 memories 表 + 对话确认沉淀 + 工作流产物沉淀 + LLM Wiki 同步);长期记忆向量召回已上线(0040 pgvector + search_memories,需配置 EMBEDDINGS_API_URL/KEY 后生效,人工确认门保持);AI 记忆管理页已上线(/memory,召回开关与删除);知识库已上线(0038:pdf/docx/md/txt 解析 + 全文检索 + 智能体上下文注入 + /knowledge 管理页);向量检索待 embedding 服务接入",
  },
  {
    id: "6",
    label: "Entitlement Service、Stripe 订阅",
    state: "partial",
    missing:
      "权益判断(0034 get_entitlements)与用量计量(0035)已就位;Stripe 应用层(checkout/portal/webhook)与订阅页已上线,但需配置 STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / 套餐 Price ID 后才可线上收款",
  },
  {
    id: "7",
    label: "全部页面接入真实数据",
    state: "partial",
    missing:
      "已接的页面全部是真实数据,无假数据;workflow/knowledge/memory/billing/skills 均已上线;技能库 0042 起组织成员可页内编辑(非工程师直接写正文,不用懂 frontmatter);reports 页面尚未创建",
  },
  {
    id: "8",
    label: "安全、监控、部署、备份回滚",
    state: "partial",
    missing: "部署、密钥加密、限流已完成;评测集(20 内置用例 + 反馈沉淀用例)与 runner 已上线(/settings/eval,结果落 eval_runs,可同版本连跑对比);反馈飞轮消费端已通(改写反馈一键同步为评测用例,message_feedback.edited → eval_cases);结构化日志、监控、备份回滚未做",
  },
];
