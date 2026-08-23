# 生产环境变量配置步骤(2026-08-11 编写,2026-08-23 更新:两项均已配置)

> **当前状态(2026-08-23 生产实测)**:EMBEDDINGS 与 STRIPE_PRICE_* 均已配置,
> `https://zhiyi-agent.com/status.json` 显示 `embeddings: true`、
> `stripe_prices_configured: 8/8`。本文档保留为**操作参考**(重配/迁移环境时使用)。
> 配置在 Vercel 控制台操作,不需要改代码;配置后 status.json 自动更新。

---

## 一、EMBEDDINGS（向量召回 / 长期记忆语义检索）

### 功能影响
配置前：记忆沉淀不写向量，召回退化为「最近优先」；知识库无向量检索。
配置后：`search_memories`（0040 pgvector）真正生效 —— 长期记忆按语义召回，知识库向量检索可用。

### 需要的 3 个变量

| 变量名 | 必填 | 示例值 | 说明 |
|---|---|---|---|
| `EMBEDDINGS_API_URL` | ✅ | `https://api.openai.com/v1/embeddings` | OpenAI 兼容 `/embeddings` 端点（也支持 DeepSeek 等兼容服务） |
| `EMBEDDINGS_API_KEY` | ✅ | `sk-...` | 对应服务的 API Key |
| `EMBEDDINGS_MODEL` | ❌ | `text-embedding-3-small` | 默认 `text-embedding-3-small`，可换（如 `text-embedding-3-large`） |

> ⚠️ 代码要求：URL 必须是 OpenAI 兼容格式，POST `{model, input}` 返回 `{data: [{embedding}]}`。
> 服务商任选（OpenAI / DeepSeek / 本地 ollama 等），只要兼容即可。

### 免费/省钱方案(2026-08-12 调研,2026-08-18 已定案实施)

| 方案 | 成本 | 维度 | 说明 |
|---|---|---|---|
| **NVIDIA nemotron-3-embed-1b**(生产在用,0070 迁移已应用) | 免费 | **2048** | 生产当前模型;要求代码发送 `input_type`(passage/query 分流),embeddings.ts 已按此实现 |
| ~~OpenAI text-embedding-3-small~~(历史默认) | ~$0.02/1M tokens | 1536 | 已替换为 nemotron,仅作历史参考 |
| ~~NVIDIA bge-m3~~(历史候选) | 免费 | 1024 | 已弃用:需迁移 1024 维,且生产已采用 nemotron 2048 |

> ⚠️ **EMBEDDINGS 变量不是金额**：`EMBEDDINGS_API_KEY` 填服务商的 API 密钥（`sk-...`），
> 不是价格数字。费用由服务商按用量计（OpenAI embedding 极便宜），代码里无任何价格字段。
> ⚠️ pgvector 维度硬上限 2000:2048 维不能再建向量索引(生产不建索引,召回走 seq scan + 过滤)。

### 操作步骤
1. 打开 Vercel → 项目 `zhiyi-ai` → **Settings → Environment Variables**
2. 添加 3 个变量（Environment 选 **Production**，可同时选 Preview/Development 方便本地测）
3. 保存后 → **Deployments → 最新部署 → ⋯ → Redeploy**（让新 env 生效）
4. 验证：打开 `https://zhiyi-agent.com/status.json` → `embeddings: true`（之前 false）

---

## 二、ENT Price（Enterprise 服务端 Checkout）

### 功能影响
配置前：Enterprise 卡片「联系销售」，`/api/billing/checkout` 对 enterprise 返回 503 → 降级 Payment Link。
配置后：checkout 走服务端 Checkout（与 Pro/Team 同链路），webhook 正确映射 price → enterprise → 权益解锁。

### 价格(2026-08-13 定价 v2:1999/19990)
Enterprise 定价 **月付 HK1,999 / 年付 HK19,990**,新 Payment Link
`7sY7sM70T0RZaM211A5AQ0D`(月)/ `00waEYdpheIP6vM25E5AQ0E`(年)。
配额在权益矩阵 0055 中 **全部 null(不限)** —— 与「企业自定义额度」定位一致。

> 💡 若想调整 Enterprise 价格:在 Stripe Dashboard 新建 Price(金额 HK1,999 起,可按企业客户单独报价),
> 用新 Price ID 填 env 即可,无需改代码。

### 需要的 2 个变量

| 变量名 | 必填 | 取值来源 |
|---|---|---|
| `STRIPE_PRICE_ENT_MONTH` | ✅ | Stripe Dashboard → Products → Enterprise 产品 → Pricing → 月付 Price 的 ID(`price_xxx`) |
| `STRIPE_PRICE_ENT_YEAR` | ✅ | 同上,年付 Price 的 ID(`price_xxx`) |

### 操作步骤
1. 打开 [Stripe Dashboard](https://dashboard.stripe.com/products) → 找到「Enterprise 企业版」产品(1999/19990)
2. 点开 Pricing,复制月付和年付两个 Price 的 ID(格式 `price_1...`)
3. Vercel → 项目 `zhiyi-ai` → Settings → Environment Variables → 添加 `STRIPE_PRICE_ENT_MONTH` / `STRIPE_PRICE_ENT_YEAR`
4. Redeploy(同 EMBEDDINGS 步骤 3)
5. 验证:`status.json` → `stripe_prices_configured: 8/8`(从 6/8 变 8/8)

---

## 三、配置后整体状态

| 指标 | 配置前 | 配置后 |
|---|---|---|
| `embeddings` | false | **true** |
| `stripe_prices_configured` | 6/8 | **8/8** |
| 向量召回 | 不可用 | **可用** |
| Enterprise 订阅 | 联系销售/降级 | **服务端 Checkout 全链路** |

## 四、验证清单（配置完成后）

```bash
# 1. status.json 两项变绿
curl https://zhiyi-agent.com/status.json
#   期望: embeddings: true, stripe_prices_configured: 8/8

# 2. Enterprise checkout 不再 503(未登录时是 401「请先登录」,不是 503)
curl -X POST https://zhiyi-agent.com/api/billing/checkout \
  -H "Content-Type: application/json" -d '{"planId":"enterprise"}'
#   期望: {"error":"请先登录。"} (401) —— 不是 503 降级

# 3. 记忆页向量召回生效(登录后 /memory,配置后搜索走语义检索)
```
