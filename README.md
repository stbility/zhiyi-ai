# 智一 AI™

面向个人知识工作的中文 AI 工作流操作系统。

## 当前状态:Phase 4 进行中(智能体与工作流)

本项目按阶段交付,每阶段以 `pnpm verify`(lint + typecheck + test + production build)全绿为验收门,
并由 GitHub Actions 在每次推送时强制执行。

**进度以 `src/lib/phase.ts` 为单一真值源,本表与它同步。** 此前这里长期停留在 Phase 1,
声称模型网关尚未交付,而它连同智能体、工作区早已在生产上跑起来 ——
低报和高报同样是不实,用户据此判断能不能用。

已经在生产上真实可用:多协议模型网关与跨厂商降级、智能体循环(步数/时间/失败三重护栏,
支持检查点续跑突破 300 秒上限)、工作区与产物预览、联网检索、Git 仓库读写与开 PR、
密钥加密与列级隔离、调用限流、RLS 隔离、记忆沉淀闭环(用户确认 → 落库 + LLM Wiki 同步,
0028)、MCP 客户端与 SKILL 技能库(0030/0031,产品侧接入外部 MCP 生态,独立于 Hermes)。

**尚未交付,不得对外宣称**:工作流状态机与后台 Worker(续跑是缓解,单次窗口内仍受平台时限约束)、
知识库与 RAG(解析/向量化/检索)、记忆管理页与记忆召回界面(沉淀闭环已通,界面未建)、
**支付收款**(权益与配额链路已生产运行,但旧 Stripe 账号已于 2026-08-10 删除、Vercel 集成与
env 已断开,新账号重建中 —— 收款处于如实 503 状态,重建完成配好 STRIPE_PRICE_* 后恢复)、
成员管理、监控与备份回滚。

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 仓库审计与差距报告 | ✅ 已完成 |
| 0.5 | 工程地基、设计系统 token 移植、配置状态注册表 | ✅ 已完成 |
| 0.6 | 38 个设计系统组件移植为 TSX + Tailwind | ✅ 已完成 |
| 1 | 数据库 Schema、迁移、RLS、Supabase 认证 | ✅ 已完成(越权隔离已实测) |
| 2 | 组织、成员、角色权限、审计日志 | 🟡 组织与审计可用;成员管理未交付,页面固定取第一个组织 |
| 3 | Provider/Model Registry、AI Gateway、Adapter、模型服务设置页 | ✅ 已完成 |
| 4 | Tool Registry、Agent、工作流状态机、Worker | 🟡 工具注册与智能体循环已完成;续跑(检查点摘要恢复,突破 300s)已实现;工作流已上线(0036:10 态状态机 + 定义/步骤编辑 + 同步执行,单次最多 5 步,运行历史留痕);后台 Worker 排队执行与人工闸门后续上线 |
| 5 | 文件上传、解析、RAG、长期记忆 | 🟡 文件夹上传、跨轮保留、上下文预算已完成;记忆沉淀闭环已实现(0028,确认 → 落库 → Wiki 同步);长期记忆向量召回已上线(0040 pgvector + search_memories,需 EMBEDDINGS_API_URL/KEY 后生效);AI 记忆管理页已上线(/memory);知识库已上线(0038,解析 + 全文检索 + /knowledge 管理页);向量检索待 embedding 服务接入 |
| 6 | Entitlement Service、Stripe 订阅 | 🟡 权益/配额(get_entitlements 0034、bump_usage 0035、402 守卫)与订阅链路(webhook/checkout/plans/billing 页)已交付并生产运行;收款暂停 —— 旧 Stripe 账号已删,新账号重建中(2026-08-10),配齐 STRIPE_PRICE_* 后恢复 |
| 7 | 全部页面接入真实数据 | 🟡 已接页面全部真实数据,无假数据;workflow/knowledge/memory/billing/skills(设置页)均已上线;reports 页面尚未创建 |
| 8 | 安全、监控、部署、备份回滚 | 🟡 部署、密钥加密、限流已完成;评测集(20 内置用例 + 反馈沉淀用例)与 runner 已上线(/settings/eval,结果落 eval_runs);反馈飞轮消费端已通(改写反馈一键同步为评测用例);结构化日志、监控、备份回滚未做 |

> 上次同步:2026-08-10,main@78324fa。本表由 scripts/sync-readme.ts 从 src/lib/phase.ts 生成;
> 改动 `src/lib/phase.ts` 后跑 `pnpm sync:readme`。线上以 https://zhiyi-ai.vercel.app/status 为准。

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
