# 智一 AI™

面向个人知识工作的中文 AI 工作流操作系统。

## 当前状态:Phase 0-3、Phase 4、Phase 7 已上线生产;Phase 5/6/8 部分上线,待开发项见下(2026-08-23)

**已上线生产交付(8 个阶段)**:Phase 0(审计)/ 0.5(工程地基)/ 0.6(设计系统组件)/ 1(数据库+RLS+认证)/
Phase 2(组织成员权限)/ 3(模型网关+注册表)/ Phase 4(Agent+工作流+Worker)/ 7(全部页面真实数据)。
**部分完成并上线生产(3 个阶段)**:Phase 5(向量写入端到端实绩待真实用户会话佐证)、
Phase 6(真实付费订阅闭环待首位真实订阅用户)、Phase 8(监控告警面板与备份演练待开发)。
**待开发(未上线)**:监控告警面板、备份演练(Phase 8 剩余项)。

本项目按阶段交付,每阶段以 `pnpm verify`(lint + typecheck + test + production build)全绿为验收门,
并由 GitHub Actions 在每次推送时强制执行。

**进度以 `src/lib/phase.ts` 为单一真值源,本表与它同步。** 此前这里长期停留在 Phase 1,
声称模型网关尚未交付,而它连同智能体、工作区早已在生产上跑起来 ——
低报和高报同样是不实,用户据此判断能不能用。

## 系统架构(2026-08-23 代码实证)

```
Frontend(Next.js 16 App Router,React 19,RSC + Server Actions + SSE)
  → API(/api/agent、/api/chat、/api/workflow、/api/billing{checkout,portal,webhook}、
       /api/mcp、/api/health、/status.json)
  → preflight(zod 校验 → 额度 get_entitlements → 并发 checkConcurrentTasks)
  → AI 编排(src/lib/ai)
      agent-turn.ts  记忆召回(向量) → 知识召回 → 工作区工具 → Git 工具 → MCP → 技能库
                      → 品牌人格 → journal(requested/executed 双记)
      agent.ts       智能体循环:连续工具调用,步数/时间/失败三重护栏,检查点续跑
      gateway.ts     多协议网关(OpenAI-compatible/Anthropic/Google),流式 + 工具 + 探测
      embeddings.ts  NVIDIA nemotron-3-embed-1b(2048 维,input_type=passage/query 分流)
  → Workflow(十态状态机 + 每步独立 Agent 运行 + Worker 排队 + 人工闸门)
  → RAG(memories 向量召回 / knowledge_files 最近优先全文召回)
  → pgvector(extensions schema,memories.embedding vector(2048))
  → PostgreSQL(38 表,72 迁移,RLS 全表隔离)
Runner(独立 runner/ 包,node 长驻进程):claim FOR UPDATE SKIP LOCKED + lease_generation
  fencing + 心跳续租 + slot pool + Hermes ACP 执行适配器 —— 突破 Vercel 300s 上限,
  只认 RUNNER_DATABASE_URL(Session Pooler IPv4:5432)
```

## 已经在生产上真实可用

多协议模型网关与跨厂商降级、智能体循环(步数/时间/失败三重护栏,支持检查点续跑突破
300 秒上限)、工作区与产物预览、联网检索、Git 仓库读写与开 PR、密钥加密与列级隔离、
调用限流、RLS 隔离、记忆沉淀闭环(用户确认 → 落库 + LLM Wiki 同步,0028)、
MCP 客户端与 SKILL 技能库(0030/0031,产品侧接入外部 MCP 生态,独立于 Hermes)、
五档定价支付全链路(checkout/webhook/plans/billing,STRIPE_PRICE_* 8 个 Price ID 生产已配齐)、
后台 Worker 排队执行 + 人工闸门(等待输入/等待确认,断点续跑)、知识库(解析 + 全文检索 + 预览)、
记忆管理页与向量召回(0040 pgvector,0070 已升级 NVIDIA nemotron-3-embed-1b 2048 维,
EMBEDDINGS 生产已配置)、评测集与反馈飞轮(/settings/eval)、
结构化日志(0056 system_logs + /api/health)、Runner 长时执行(独立包,突破 300s 上限)、
部署门禁(PR 级 preview 验证 + 分支保护 + 生产 SHA 对齐兜底)。

**部署门禁(持续生效)**:CI 全绿 ≠ 生产交付 —— main 分支保护强制
「部署闭环验证」,Vercel 构建失败 → PR 红 → 合不进去;生产 SHA 对齐
(`/status.json` deployed_sha == origin/main)由 push 后验证兜底。

> 环境配置现状(2026-08-23 生产实测 status.json):STRIPE_PRICE_* 8 个 Price ID 已配齐
> (stripe_prices_configured=8/8,checkout 走服务端 Checkout 主路径)、
> EMBEDDINGS_API_URL/KEY 已配置(embeddings=true,向量检索链路就绪;
> 模型为 NVIDIA nemotron-3-embed-1b 2048 维,见 docs/env-config-guide.md)、
> RESEND_API_KEY 已配置(email=configured,事务邮件可用)。
> Payment Link 8 个已对齐(2026-08-13 定价 v2):PRO/PRO_PLUS/TEAM/ENT × 月付/年付,
> 对应关系见 .env.example(plink ID 与 webhook PLINK_TO_PLAN 一一对应)。

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 仓库审计与差距报告 | ✅ 已完成 |
| 0.5 | 工程地基、设计系统 token 移植、配置状态注册表 | ✅ 已完成 |
| 0.6 | 38 个设计系统组件移植为 TSX + Tailwind | ✅ 已完成 |
| 1 | 数据库 Schema、迁移、RLS、Supabase 认证 | ✅ 已完成并上线生产(越权隔离已实测;认证四类用户 E2E PASS:新注册/普通/管理员/OAuth) |
| 2 | 组织、成员、角色权限、审计日志 | ✅ 已完成并上线生产(数据库层 0001 + 品牌人格 /settings/persona + 成员管理 /settings/members + 组织切换器) |
| 3 | Provider/Model Registry、AI Gateway、Adapter、模型服务设置页 | ✅ 已完成并上线生产(多协议网关、跨厂商降级、平台免费档) |
| 4 | Tool Registry、Agent、工作流状态机、Worker | ✅ 已完成并上线生产(工具注册与智能体循环;续跑突破 300s;工作流 0036 十态状态机 + 运行历史;后台 Worker 入队化 + /api/workflow/worker + 人工闸门双通道,断点续跑;并发数权益双入口检查) |
| 5 | 文件上传、解析、RAG、长期记忆 | 🟡 部分完成并上线生产:文件夹上传、跨轮保留、上下文预算已完成;记忆沉淀闭环(0028)已上线;向量召回链路已上线(0040 + 0070 nemotron-3-embed-1b 2048 维 + input_type 分流,EMBEDDINGS 生产已配置);AI 记忆管理页(/memory)、知识库(0038,解析 + 全文检索 + /knowledge)已上线。待开发:向量写入端到端实绩佐证(需真实用户会话沉淀记忆) |
| 6 | Entitlement Service、Stripe 订阅 | 🟡 部分完成并上线生产:五档定价(Free/49/149/499/1999)全链路生产运行(checkout/webhook/plans/billing);STRIPE_PRICE_* 8 个 Price ID 生产已配齐(8/8);Payment Link 8 个已对齐;权益矩阵 0055(30 行种子);六项营销承诺全部 gating。待开发:真实付费订阅端到端闭环验证(待首位真实订阅用户) |
| 7 | 全部页面接入真实数据 | ✅ 已完成并上线生产(workflow/knowledge/memory/billing/skills/eval/reports 全部真实数据,无假数据) |
| 8 | 安全、监控、部署、备份回滚 | 🟡 部分完成并上线生产:部署门禁 + 生产 SHA 对齐、密钥加密、限流、评测集与反馈飞轮(/settings/eval)、Runner 长时执行(独立包,突破 300s)、结构化日志(0056 + /api/health)、备份回滚指南(docs/backup-restore.md)均已上线。待开发:监控告警面板、备份演练 |

> 上次同步:2026-08-23,main@ccf250f。本表由 scripts/sync-readme.ts 从 src/lib/phase.ts 生成;
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

## 设计系统继承规则

`src/styles/tokens/*.css` 与 `src/styles/base.css` 是从「智一 AI™ 设计系统」**逐字节复制**的,为设计 token 的唯一真值源。

- **禁止修改这些文件中的任何值。** 变更由 `tests/design-system/token-parity.test.ts` 断言拦截。
- `src/app/globals.css` 只做映射,把已有 CSS 变量接入 Tailwind v4 theme,不新增、不覆盖任何设计值。映射正确性由 `tests/design-system/computed-tokens.test.ts` 编译后断言。
- 组件中禁止写死颜色、禁止使用 Tailwind 默认调色板,由 `tests/design-system/no-hardcoded-values.test.ts` 拦截。
- 组件清单直接读设计系统的 `_ds_manifest.json` 比对,漏移植或改名由 `tests/design-system/component-parity.test.ts` 拦截。
- `cn()` 已把设计系统全部 scale 登记进 tailwind-merge,新增 token 时须同步更新 `src/lib/cn.ts`,否则该 token 参与 className 合并时会被静默覆盖。

## 关于密钥

- AI Provider 的 API 密钥**不通过环境变量配置**。用户在产品内「设置 → 模型服务」添加,加密存于数据库,支持测试连接、轮换与撤销(Phase 3 交付)。
- 环境变量只放基础设施凭据(Supabase、Stripe)与加密主密钥 `ENCRYPTION_KEY`。
- `src/lib/env/server.ts` 带 `server-only` 标记,客户端组件误引用会在构建期报错,保证密钥不会进入浏览器产物。
- 日志与错误响应中的密钥一律经 `maskSecret()` 掩码,只保留末 4 位。

## 技术栈

Next.js 16(App Router)· TypeScript 严格模式 · Tailwind CSS 4 · Supabase · PostgreSQL + pgvector · Stripe · Zod · Vitest
