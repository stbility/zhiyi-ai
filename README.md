# 智一 AI™

面向个人知识工作的中文 AI 工作流操作系统。

## 当前状态:Phase 0.6 已完成

本项目按阶段交付,每阶段以 `pnpm verify`(lint + typecheck + test + production build)全绿为验收门。

**必须如实理解当前进度:工程地基与设计系统移植已完成,产品能力尚未实现。**
根路径 `/` 是系统配置状态页,展示各外部服务的真实接入状态,不含任何模拟数据。

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 仓库审计与差距报告 | ✅ 已完成 |
| 0.5 | 工程地基、设计系统 token 移植、配置状态注册表 | ✅ 已完成 |
| 0.6 | 38 个设计系统组件移植为 TSX + Tailwind | ✅ 已完成 |
| 1 | 数据库 Schema、迁移、RLS、Supabase 认证 | ⬜ 未开始 |
| 2 | 组织、成员、角色权限、审计日志 | ⬜ 未开始 |
| 3 | Provider/Model Registry、AI Gateway、Adapter、模型服务设置页 | ⬜ 未开始 |
| 4 | Tool Registry、Agent、工作流状态机、Worker | ⬜ 未开始 |
| 5 | 文件上传、解析、RAG、长期记忆 | ⬜ 未开始 |
| 6 | Entitlement Service、Stripe 订阅 | ⬜ 未开始 |
| 7 | 全部页面接入真实数据 | ⬜ 未开始 |
| 8 | 安全、监控、部署、备份回滚 | ⬜ 未开始 |

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
