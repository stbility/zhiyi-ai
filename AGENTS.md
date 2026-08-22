# AGENTS.md — 智一 AI 开发引导(所有代理/窗口开工前必读)

这个文件是给**任何新开窗口、新代理、新会话**的强制引导。目标:从源头消灭
「读到的系统结构与实际阶段不一致」导致的反复修复。

## 0. 开工第一步(必做,别跳过)

```bash
bash scripts/bootstrap.sh
```

它做:fetch origin/main → 对齐 → 打印当前阶段(phase.ts)、生产实况
(/status.json)、与本地差异。**任何窗口先跑它再动手。**

## 1. 状态真值源(别猜,按优先级取)

| 想看什么 | 去哪看 | 禁止 |
|---|---|---|
| 系统开发阶段 | `src/lib/phase.ts`(唯一真值源) | 禁止信 README 阶段表(生成物) |
| 生产实况(部署 SHA/配置) | `https://zhiyi-agent.com/status.json` | 禁止从本地/旧克隆推断生产 |
| 迁移账本顶 | `supabase/migrations/MANIFEST.md` | 禁止凭 CI 绿推断已交付 |
| 支付链路现状 | `docs/payment-loop-runbook.md` | 禁止凭记忆改支付代码 |

**交付判定(缺一不算交付)**:CI 绿 + 生产迁移已应用(prod-migrations run 日志)+
`/status.json` 的 deployed_sha == origin/main SHA + 页面渲染冒烟 200。
CI 全绿 ≠ 生产交付,这是本仓库铁律。

## 2. 工作区纪律(防互相污染)

- **禁止共享克隆**:每个窗口 `git worktree add /tmp/<窗口名> origin/main` 独立
  工作区,或至少基于刚 fetch 的 origin/main 重建分支。
- 判断 main 状态前先 `git fetch origin main:refs/remotes/origin/main`。
- 提交前 `git branch --show-current` 确认分支;commit 只用自己 add 的文件。
- 收到「暂停/停止/删除」指令 = 立即停所有工具,报告状态,等下一步。

## 3. 写代码/文档的规则

- 改支付/订阅代码前先读 `docs/payment-loop-runbook.md`(病根与验收清单)。
- 改迁移:必须同步 MANIFEST.md + 契约快照(`check-migrations.sh --sync`),等
  CI「真实 PostgreSQL 迁移重放」绿。
- 改 README 阶段表:跑 `pnpm sync:readme`(从 phase.ts 生成),不手改。
- 所有产出走分支 + PR,不直推 main;合入由用户决定。

## 4. 本仓库关键事实

- 栈:Next.js 16 / Supabase / Stripe / pnpm;live: https://zhiyi-agent.com
- 门禁:`pnpm verify`(lint → typecheck → test → build)+ CI 真实迁移重放。
- 支付:旧 Stripe 账号已删(2026-08-10),新账号重建中;STRIPE_PRICE_* 未配
  = checkout 如实 503 → 降级 Payment Link,不是 bug。
