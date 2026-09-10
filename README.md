# 智一 AI™(ZHIYI AGENT · 智一智能体)

面向个人知识工作的中文 AI 工作流操作系统 —— 把想法变成可执行的工作流,
让智能体替你完成多步骤任务,产出可交付的成果。

## 正式入口

- **产品**:https://zhiyi-agent.com
- **邮件**:ZHIYI AGENT <noreply@mail.zhiyi-agent.com>
- **订阅与计费**:https://zhiyi-agent.com/billing

## 产品能力

- **智能体工作台**:用自然语言创建任务,智能体自动规划步骤、调用工具、连续执行,产出成果文件
- **多模型自由选择**:接入主流大模型或自带服务,按需切换,跨厂商自动降级
- **工作流编排**:多步骤任务按状态机执行,支持人工确认/等待输入,断点续跑,长任务不再超时
- **知识库与长期记忆**:上传文档建立知识库,智能体基于知识工作;记忆自动沉淀,越用越懂你
- **团队协作**:组织、成员、角色权限管理,审计留痕
- **工具生态**:联网检索、Git 仓库读写与开 PR、MCP 生态接入、技能库
- **完整商业闭环**:五档订阅定价(Free/Pro/Pro Plus/Team/Enterprise),在线支付、账单与权益自动生效

## 交付状态(2026-08-23)

- **已上线生产(Phase 0-3、Phase 4、Phase 7)**:认证与账户、组织与成员、模型网关、
  智能体与工作流、全部页面真实数据、评测与反馈、结构化日志与健康检查、部署闭环验证
- **部分上线,待开发项见阶段表(Phase 5/6/8)**:知识库向量检索实绩佐证、真实付费订阅
  闭环验证、监控告警面板与备份演练

本项目按阶段交付,每阶段以 `pnpm verify`(lint + typecheck + test + production build)全绿为验收门,
并由 GitHub Actions 在每次推送时强制执行。**进度以 `src/lib/phase.ts` 为单一真值源,本表与它同步。**

> 环境配置现状(2026-08-23 生产实测):订阅价格 8/8 已配齐、向量检索服务已配置、
> 事务邮件已配置。生产事实以 https://zhiyi-agent.com/status.json 为准。

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 仓库审计与差距报告 | ✅ 已完成 |
| 0.5 | 工程地基、设计系统 token 移植、配置状态注册表 | ✅ 已完成 |
| 0.6 | 38 个设计系统组件移植为 TSX + Tailwind | ✅ 已完成 |
| 1 | 数据库 Schema、迁移、RLS、Supabase 认证 | ✅ 已完成并上线生产(越权隔离已实测;认证四类用户 E2E PASS:新注册/普通/管理员/OAuth) |
| 2 | 组织、成员、角色权限、审计日志 | ✅ 已完成并上线生产(组织管理、成员管理、角色权限、操作留痕) |
| 3 | Provider/Model Registry、AI Gateway、Adapter、模型服务设置页 | ✅ 已完成并上线生产(多协议网关、跨厂商降级、平台免费档) |
| 4 | Tool Registry、Agent、工作流状态机、Worker | ✅ 已完成并上线生产(智能体循环 + 断点续跑;工作流编排 + 运行历史;后台排队执行 + 人工确认/等待输入双闸门;并发权益双入口检查) |
| 5 | 文件上传、解析、RAG、长期记忆 | 🟡 部分完成并上线生产:文件上传与跨轮保留、记忆沉淀闭环、AI 记忆管理页、知识库(解析 + 全文检索)均已上线;向量检索链路已就绪。待开发:向量写入端到端实绩佐证(需真实用户会话沉淀记忆) |
| 6 | Entitlement Service、Stripe 订阅 | 🟡 部分完成并上线生产:五档定价全链路(在线支付、账单、权益自动生效)、订阅价格 8/8 已配齐、备用支付链接已对齐。待开发:真实付费订阅端到端闭环验证(待首位真实订阅用户) |
| 7 | 全部页面接入真实数据 | ✅ 已完成并上线生产(工作流/知识库/记忆/计费/技能/评测/报表全部真实数据,无假数据) |
| 8 | 安全、监控、部署、备份回滚 | 🟡 部分完成并上线生产:安全与限流、密钥加密、评测集与反馈飞轮、长任务执行器、结构化日志与健康检查、备份回滚指南均已上线。待开发:监控告警面板、备份演练 |

> 上次同步:2026-08-23,main@98c98a9。本表由 scripts/sync-readme.ts 从 src/lib/phase.ts 生成;
> 改动 `src/lib/phase.ts` 后跑 `pnpm sync:readme`。线上以 https://zhiyi-agent.com/status 为准。

## 开始开发

```bash
pnpm install
```

环境变量由 Vercel 的 Supabase / Stripe 集成生成,本地拉取:

```bash
vercel env pull
```

也可复制 `.env.example` 为 `.env.local` 手工填写。**未填写不会导致启动失败** —— 对应能力会在配置状态页显示「未配置」。这是刻意设计:未接通的服务必须如实展示,不得伪装为已接通,更不得回退到假数据。

```bash
pnpm dev
```

- `/` —— 系统配置状态页
- `/gallery` —— 组件走查页,仅开发环境可访问,生产构建返回 404

## 验收命令

```bash
pnpm verify
```

单项:`pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build`

## 开发者须知

- **设计系统**:`src/styles/tokens/*.css` 与 `src/styles/base.css` 为设计 token 唯一真值源,禁止修改其中的值(由 `tests/design-system/token-parity.test.ts` 断言拦截);组件禁止写死颜色,由 `tests/design-system/no-hardcoded-values.test.ts` 拦截。
- **密钥**:AI Provider 的 API 密钥**不通过环境变量配置**,用户在产品内「设置 → 模型服务」添加,加密存于数据库;环境变量只放基础设施凭据(Supabase、Stripe)与加密主密钥 `ENCRYPTION_KEY`;日志与错误响应中的密钥一律经 `maskSecret()` 掩码,只保留末 4 位。

## 技术栈

Next.js 16(App Router)· TypeScript 严格模式 · Tailwind CSS 4 · Supabase · PostgreSQL + pgvector · Stripe · Zod · Vitest
