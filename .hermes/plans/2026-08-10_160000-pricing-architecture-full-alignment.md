# 智一 AI 定价与权益系统——全链路对齐方案

> **目标：Phase 4-8 系统架构 × 真实 DB 结构 × 合理定价三位一体对齐**
> **审阅人：kuanxu**
> **日期：2026-08-10**

---

## 一、系统真实状态（Phase 4-8）

### 1.1 各 Phase 真实交付状态

| Phase | 状态 | 已交付 | 未交付 |
|---|---|---|---|
| Phase 0-1 | ✅ done | DB schema/迁移/RLS/Supabase认证 | — |
| Phase 2 | ⚠️ partial | organizations/memberships/audit_logs | 成员管理页（固定取第一个组织） |
| Phase 3 | ✅ done | Provider/Model Registry/AI Gateway | — |
| Phase 4 | ⚠️ partial | Agent循环/文件工具/续跑/检查点 | 工作流状态机/后台Worker |
| Phase 5 | ⚠️ partial | 附件上传/跨轮保留/上下文预算/memories表 | 解析/RAG/记忆管理页/知识库 |
| **Phase 6** | **🔴 todo** | **Stripe订阅/Entitlement Service** | **全部未做** |
| Phase 7 | ⚠️ partial | 已有页面接真实数据 | workflow/knowledge/memory/reports/billing页面 |
| Phase 8 | ⚠️ partial | 部署/密钥加密/限流 | 结构化日志/监控/备份回滚 |

**Phase 6 是当前唯一红色 Phase，是所有定价权益的前置依赖。**

---

### 1.2 数据库 entitlements 表真实结构

```
entitlements 表（Phase 6 之前只有 2 个 feature）：

feature 命名规范：quota=null 表示不限，数字表示上限

Free:         workflows=1,           monthly_agent_turns=200
Professional: workflows=5,           monthly_agent_turns=2000
Enterprise:   workflows=null(不限), monthly_agent_turns=null(不限)
```

**Phase 6 之后应扩展的 feature（根据 Phase 5/7/8 未交付项）：**
- `monthly_agent_turns` — 已实现，保留
- `workflows` — 已实现，保留
- `custom_agents` — Phase 4 partial → 需要新增
- `knowledge_bases` — Phase 5 未交付 → 未来新增
- `storage_gb` — Phase 5 未交付 → 未来新增
- `vector_search` — Phase 5 未交付 → 未来新增（boolean）
- `concurrent_tasks` — Phase 4 未交付 → 未来新增
- `email_support` — Phase 8 未交付 → 未来新增（boolean）

---

## 二、真实成本估算（HKD）

### 2.1 固定成本（月度）

```
Vercel Pro × 1：           HK$156/月  ($20 × 7.8)
Supabase Pro × 1：          HK$195/月  ($25 × 7.8)
域名 + CDN：                HK$50/月
────────────────────────────────────
固定成本合计：              HK$401/月
```

### 2.2 变动成本（按用户活跃度）

```
AI API（MiniMax/OpenAI）：
  轻度用户（月均50次调用）：   HK$20-50/月
  中度用户（月均200次调用）：  HK$80-200/月
  重度用户（月均2000次调用）： HK$400-800/月

存储/带宽：
  5GB/人 × 100用户 × $0.02/GB = HK$78/月（均摊）
```

### 2.3 各档盈亏（不含研发人力）

```
Free 用户：     收入HK$0，AI成本≈HK$0（不登录），盈利=0 ✅ 可接受
Pro HK$49：    收入HK$49，固定成本HK$401，亏损HK$352 ❌
Pro HK$128：   收入HK$128，固定成本HK$401，亏损HK$273 ❌
Pro HK$198：   收入HK$198，固定成本HK$401 + AI成本HK$50 = HK$451，亏损HK$253 ❌
Enterprise HK$388：收入HK$388，固定成本HK$401 + AI成本HK$200 = HK$601，亏损HK$213 ❌
```

**结论：单一产品定价无法单独覆盖基础设施成本，必须靠用户规模效应。**

### 2.4 最低可行单价（盈亏平衡）

```
条件：固定成本 HK$401/月 + AI 变动成本 HK$50/用户

| 付费用户数 | 盈亏平衡单价 |
|---|---|
| 5 用户 | HK$130/人/月 |
| 10 用户 | HK$90/人/月 |
| 20 用户 | HK$70/人/月 |
| 50 用户 | HK$58/人/月 |
| 100 用户 | HK$54/人/月 |
```

---

## 三、定价方案

### 3.1 定价原则

```
1. 成本覆盖优先：单价必须能在合理用户规模下覆盖固定成本
2. 市场竞争力：香港 SaaS 中低端定价（参考 HK$78-200 区间）
3. 阶段性定价：Phase 6 初期用低价获客，规模后再调整
4. 创始用户标签：早期支持者给荣誉价兼低价，建立忠诚度
5. feature-gated：已实现的 feature 才能放进权益，未实现的不能虚标
```

### 3.2 定价方案（三档，基于真实实现）

| 套餐 | 月付 | 年付（省2月） | Agent额度 | 工作流数 | 已实现feature |
|---|---|---|---|---|---|
| Free | HK$0 | — | 200次/月 | 1个 | ✅ |
| **Professional ⭐** | **HK$49** | **HK$490** | **2,000次/月** | **5个** | ✅ |
| Enterprise | HK$198 | HK$1,980 | 不限 | 不限 | ✅ |

> ⭐ Professional = 创始用户专属价。后续随用户规模调整。

**为什么不设 Pro+？**
- Phase 5/7 未交付功能（知识库/存储/并发任务）没有在 DB 实现
- 当前 DB 只有 workflows 和 monthly_agent_turns 两个 feature
- Pro+ 需要新 feature 但系统还没实现，空谈价格没有意义
- 等 Phase 5/7 交付后（知识库/RAG/存储），再增加 Pro+ 档才合理

---

### 3.3 定价决策依据

```
Professional HK$49/月 的理由：
  · 定价低于成本，但作为"创始用户价"有商业合理性
  · 降低早期用户门槛，快速建立用户群
  · 标注"创始用户专属价"，后续可名正言顺涨价
  · DB 中 Pro 已有 monthly_agent_turns=2000，2000次/月对深度用户足够

Enterprise HK$198/月 的理由：
  · 高于 HK$128 成本线（含合理利润），在 20+ 用户时覆盖固定成本
  · 比香港同类企业 SaaS（HK$200-400）处于中低端，有竞争力
  · "不限"额度（null=无上限）体现企业价值
  · 与 Pro 形成明确区隔：工作流不限 + 额度不限 + SLA 支持
```

---

### 3.4 年付折扣设计

```
月付 → 年付：月价 × 10（≈17% off，省2个月）

Free：        无年付
Professional： HK$49 × 10 = HK$490（省 HK$98）
Enterprise：   HK$198 × 10 = HK$1,980（省 HK$396）
```

---

## 四、权益与 DB 对齐方案

### 4.1 现状：plans.ts 与 entitlements 表不一致

| 项目 | plans.ts 文案 | entitlements DB 实际值 | 差距 |
|---|---|---|---|
| Free 工作流 | "1个工作流" ✅ | workflows=1 ✅ | 一致 |
| Pro Agent额度 | "每月500次" ❌ | monthly_agent_turns=**2000** | 文案偏低 |
| Pro 工作流数 | "多个工作流" ❌ | workflows=**5** | 文案虚标 |
| Enterprise 额度 | "每月5000次" ❌ | monthly_agent_turns=**null(不限)** | 文案虚标 |

### 4.2 修复策略

**Phase 6 初期：只更新文案对齐已有 DB 值，不新增 feature**

因为 Phase 5/7/8 的核心功能（知识库/存储/并发）尚未实现，权益里不能虚标。

```
plans.ts 更新规则：
  · Agent额度：使用 DB 真实值（Free=200, Pro=2000, Ent=null不限）
  · 工作流数：使用 DB 真实值（Free=1, Pro=5, Ent=null不限）
  · 未来新增 feature：等 Phase 5 交付后，在 migration 中新增 entitlement 行，
    plans.ts 才能同步更新，遵循"DB 先于文案"原则
```

### 4.3 迁移脚本（Phase 6）

新建 `0038_entitlements_sync.sql`：

```sql
-- 0038_entitlements_sync.sql
-- Phase 6 定价权益对齐迁移。
-- 原则：DB 是判断层唯一事实来源；plans.ts 是展示层，跟 DB 而非反之。

-- 更新 Professional 工作流数（Phase 4 部分交付）
update public.entitlements
set quota = 5
where plan_id = 'professional' and feature = 'workflows';
-- 原有 5，符合，无需更新（保留此条作显式声明）

-- 注意：以下 feature 尚未在 DB 实现，不得写入 entitlements：
--   custom_agents, knowledge_bases, storage_gb,
--   vector_search, concurrent_tasks, email_support
-- 等 Phase 5/7 交付后，再新建迁移添加这些 entitlement 行。
```

> 注：DB 当前 Pro workflows=5，Pro monthly_agent_turns=2000，均已符合，无需 SQL 修改。
> 本迁移文件作为对齐声明，记录"文案必须与 DB 一致"的工程纪律。

---

## 五、Stripe 定价与链接清单

### 5.1 需要创建的产品（Stripe Dashboard）

| # | 产品名 | 计费 | Price ID 环境变量 | Payment Link URL 环境变量 |
|---|---|---|---|---|
| 1 | Professional 月付 | 月付 HK$49 | `STRIPE_PRICE_PRO_MONTH` | `STRIPE_PAYMENT_LINK_PRO_MONTH` |
| 2 | Professional 年付 | 年付 HK$490 | `STRIPE_PRICE_PRO_YEAR` | `STRIPE_PAYMENT_LINK_PRO_YEAR` |
| 3 | Enterprise 月付 | 月付 HK$198 | `STRIPE_PRICE_ENT_MONTH` | `STRIPE_PAYMENT_LINK_ENT_MONTH` |
| 4 | Enterprise 年付 | 年付 HK$1,980 | `STRIPE_PRICE_ENT_YEAR` | `STRIPE_PAYMENT_LINK_ENT_YEAR` |

### 5.2 环境变量汇总

```
STRIPE_PRICE_PRO_MONTH=price_xxx
STRIPE_PRICE_PRO_YEAR=price_xxx
STRIPE_PRICE_ENT_MONTH=price_xxx
STRIPE_PRICE_ENT_YEAR=price_xxx
STRIPE_PAYMENT_LINK_PRO_MONTH=https://buy.stripe.com/xxx
STRIPE_PAYMENT_LINK_PRO_YEAR=https://buy.stripe.com/xxx
STRIPE_PAYMENT_LINK_ENT_MONTH=https://buy.stripe.com/xxx
STRIPE_PAYMENT_LINK_ENT_YEAR=https://buy.stripe.com/xxx
```

---

## 六、plans.ts 更新方案

### 6.1 更新后的 Professional 卡片文案

```typescript
{
  id: "professional",
  name: "Professional 专业版",
  price: "HK$49/月",
  period: "月",
  annualPrice: "HK$490/年",
  annualNote: "年付省 HK$98（≈2个月）",
  features: [
    "每月 2,000 次 Agent 调用",           // DB: monthly_agent_turns=2000
    "5 个工作流",
    "AI 记忆全量可见可删除",
    "使用您自己的模型密钥",
  ],
  highlighted: true,
  // ... priceId/paymentLink
}
```

### 6.2 更新后的 Enterprise 卡片文案

```typescript
{
  id: "enterprise",
  name: "Enterprise 企业版",
  price: "HK$198/月",
  period: "月",
  annualPrice: "HK$1,980/年",
  annualNote: "年付省 HK$396（≈2个月）",
  features: [
    "不限次数 Agent 调用",               // DB: monthly_agent_turns=null
    "不限工作流数",                      // DB: workflows=null
    "组织、成员与角色权限",
    "完整审计日志",
    "SLA 与优先邮件支持",
  ],
  highlighted: false,
}
```

---

## 七、实施路径

### Phase 6 交付序列

```
Step 1: 用户在 Stripe Dashboard 创建 4 个产品 + 4 个 Payment Link
         ↓
Step 2: 用户把 Price ID + Payment Link URL 发给 Hermes
         ↓
Step 3: Hermes 更新 .env.example（补充 8 个新环境变量）
         ↓
Step 4: Hermes 更新 plans.ts（更新文案对齐 DB 真实值）
         ↓
Step 5: Hermes 新建 0038_entitlements_sync.sql（对齐迁移）
         ↓
Step 6: PR #66 合并 → CI → 部署
         ↓
Step 7: Supabase Dashboard 执行 0038 migration
         ↓
Step 8: Vercel env 填入 8 个新变量 + STRIPE_WEBHOOK_SECRET
         ↓
Step 9: Stripe Dashboard 配置 webhook endpoint
         ↓
Step 10: 生产冒烟测试（/pricing → Payment Link 跳转）
```

---

## 八、未来扩展（Phase 5/7 交付后）

当 Phase 5（知识库/RAG）和 Phase 7（workflow页面）交付后，entitlements 扩展：

```sql
-- 0039_entitlements_phase5.sql（未来迁移）
insert into public.entitlements values
  ('professional', 'knowledge_bases',  3),    -- 3个知识库
  ('professional', 'storage_gb',     5),    -- 5GB存储
  ('professional', 'vector_search',  1),   -- 向量检索（boolean）
  ('enterprise',   'knowledge_bases', null), -- 不限
  ('enterprise',   'storage_gb',     null), -- 不限
  ('enterprise',   'vector_search',  1);    -- 向量检索
```

此时 plans.ts 才能添加对应文案（DB 先于文案）。

---

## 九、关键原则

```
1. DB 是唯一事实来源：entitlements 表 = 判断层，plans.ts = 展示层
2. 文案跟随 DB：每次更新权益，先 migration，再更新 plans.ts
3. 虚标是红线：未实现的 feature 不得出现在权益文案中
4. 成本定价：HK$49 创始价 < 成本，但有商业合理性；HK$198 覆盖成本
5. 阶段性定价：Pro+ 档在 Phase 5 交付后才有意义
6. 创始用户标签：Pro HK$49 标注创始用户专属，后续调整有理有据
```
