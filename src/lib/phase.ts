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
  label: "Phase 4(智能体与工作流,已上线生产)",
  /**
   * 产品能力(需求三至六章)是否已经开始交付。
   *
   * 现在为 true,依据是这些已经在生产上真实可用:
   *   · 模型网关与服务商注册表(多协议、跨厂商降级、真实调用验证)
   *   · 智能体循环与文件工具(产物写入工作区,带步数/时间/失败三重护栏)
   *   · 联网检索(Tavily,强制标注来源)
   *   · 项目附件跨轮保留与上下文预算装配
   *   · 工作流(0036:10 态状态机 + Worker 排队 + 人工闸门)、知识库(0038)、长期记忆(0028/0040)
   *   · 订阅与计费(五档定价全链路,STRIPE_PRICE_* 8/8 生产已配齐)、成员管理与组织切换(阶段 2)、
   *     评测集与反馈飞轮(阶段 8)
   *
   * 尚未交付、不得对外宣称的:监控(告警/指标面板)、备份演练。
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
 * 这份清单必须对照代码核对后再改,不能凭印象。上一次核对:2026-08-23,
 * 依据是 src/ 下实际存在的模块、生产 status.json 指纹(部署 SHA/环境配置)
 * 与生产库里跑通的链路。
 */
export const PHASE_STATUS: readonly PhaseStatus[] = [
  { id: "0", label: "仓库审计与差距报告", state: "done" },
  { id: "0.5", label: "工程地基与设计系统 token 移植", state: "done" },
  { id: "0.6", label: "设计系统组件移植为 TSX + Tailwind", state: "done" },
  { id: "1", label: "数据库 Schema、迁移、RLS、Supabase 认证", state: "done" },
  {
    id: "2",
    label: "组织、成员、角色权限、审计日志",
    state: "done",
  },
  {
    id: "3",
    label: "Provider/Model Registry、AI Gateway、Adapter、模型服务设置页",
    state: "done",
  },
  {
    id: "4",
    label: "Tool Registry、Agent、工作流状态机、Worker",
    state: "done",
    missing: "工具注册与智能体循环已完成;续跑(检查点摘要恢复,突破 300s 上限)已实现;工作流已上线(0036:10 态状态机 + 定义/步骤编辑 + 运行历史留痕);后台 Worker 已上线(2026-08-12:runWorkflow 入队化 + /api/workflow/worker 用户触发执行 + Vercel Cron 兜底清僵尸;人工闸门双通道:等待输入 needsInput / 等待确认 needsApproval,断点续跑);并发数权益(0055 concurrent_tasks)已在 agent 入口与 workflow 入队双检查",
  },
  {
    id: "5",
    label: "文件上传、解析、RAG、长期记忆",
    state: "partial",
    missing:
      "文件夹上传、跨轮保留、上下文预算已完成;记忆沉淀闭环已实现(0028 memories 表 + 对话确认沉淀 + 工作流产物沉淀 + LLM Wiki 同步);长期记忆向量召回已上线(0040 pgvector + search_memories,0070 已升级 NVIDIA nemotron-3-embed-1b 2048 维,embeddings.ts 已按 Nemotron 要求拆分 input_type=passage/query,EMBEDDINGS_API_URL/KEY 生产已配置);AI 记忆管理页已上线(/memory,召回开关与删除);知识库已上线(0038:pdf/docx/md/txt 解析 + 全文检索 + 智能体上下文注入 + /knowledge 管理页);向量检索链路已就绪(生产 status.json embeddings=true),向量写入端到端实绩待记忆数据佐证(需真实用户会话沉淀记忆,人工确认门保持)",
  },
  {
    id: "6",
    label: "Entitlement Service、Stripe 订阅",
    state: "partial",
    missing:
      "权益判断(0034 get_entitlements)与用量计量(0035)已就位;五档定价(Free/49/149/499/1999)全链路生产运行:checkout/webhook/plans/billing 已上线;STRIPE_PRICE_* 8 个 Price ID 生产已配齐(2026-08-23 实测 status.json stripe_prices_configured=8/8,checkout 走服务端 Checkout 主路径);Payment Link 8 个已对齐(2026-08-13 定价 v2:PRO/PRO_PLUS/TEAM/ENT × 月付/年付,见 .env.example,未配时 checkout 如实 503 降级 Payment Link);权益矩阵已扩展(0055:concurrent_tasks/history_days/knowledge_capacity/mcp_servers 四类 feature,生产 30 行种子实证);六项营销承诺全部 gating:MCP 登记、知识库上传、并发任务数(agent+workflow 双入口,2026-08-12)、历史保留天数(会话列表过滤,2026-08-12)、工作流数量、月度智能体额度;真实付费订阅端到端闭环待首位真实订阅用户验证(webhook→落库→权益生效全链路代码+测试就绪)",
  },
  {
    id: "7",
    label: "全部页面接入真实数据",
    state: "done",
  },
  {
    id: "8",
    label: "安全、监控、部署、备份回滚",
    state: "partial",
    missing: "部署、密钥加密、限流已完成;评测集(20 内置用例 + 反馈沉淀用例)与 runner 已上线(/settings/eval,结果落 eval_runs,可同版本连跑对比);反馈飞轮消费端已通(改写反馈一键同步为评测用例,message_feedback.edited → eval_cases);结构化日志已上线(0056 system_logs + lib/logging,工作流完成/失败/暂停/僵尸清理埋点,2026-08-12);健康检查已上线(/api/health:Supabase 连通 + 依赖指纹,200/503);备份回滚指南已交付(docs/backup-restore.md:Supabase 平台备份 + 迁移回滚姿势 + 季度演练清单);监控(告警/指标面板)与备份演练未做",
  },
];
