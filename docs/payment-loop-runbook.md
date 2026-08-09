# 支付闭环运行手册(订阅 → 支付 → 解锁 → 交付)

> 本文件记录智一 AI 支付闭环的**真实状态、反复修复的病根与验证方法**。
> 每次动支付代码前先读它 —— 这个闭环已经修过很多次,病根都是同一个模式:
> **代码认为「配置好了」,生产实际没有;或者路由活着,却没有任何调用方。**

## 一、链路图(2026-08-09 现状)

```
定价页 / 落地页
  └─ SubscribeButton(主路径)→ POST /api/billing/checkout
       ├─ 401 未登录 → /login?next=当前页(绝不降级,未登录付款归不了户)
       ├─ 200 {url} → Stripe Checkout Session(metadata.userId)
       │     └─ 付款 → webhook(checkout.session.completed / subscription.*)
       │           └─ subscriptions 落库 → get_entitlements → 权益/配额生效
       └─ 5xx(Price ID 未配/目录找不到)→ 降级 Payment Link(带 prefilled_email)
             无 fallbackUrl 时兜到 /billing(页面上有「Stripe 尚未配置」如实横幅)
```

> **按钮下方不挂任何文字**(2026-08-09)。此前降级时会在按钮下面显示一行
> 「正在改用备用支付链接…请使用同一邮箱付款」——点击的下一刻页面就在跳转,
> 那行字要么一闪而过,要么在慢跳转时糊在卡片上。用户是成熟用户,不需要这种
> 中间态解说。现在四条分支的终点都是**真实跳转**,失败原因写进 `console.warn`
> 供排查,界面保持干净。守卫测试:「订阅按钮下方不挂任何说明性文字」。

- **主路径**:服务端 Checkout Session(metadata.userId 精确归属)—— 2026-08-09 ba422de 恢复
- **备用路径**:Payment Link + prefilled_email(仅主路径确实不可用时)
- **webhook 端点**:`we_1U2JVmPw7bzqE3HKiY79EMUy` → 已配「发送所有事件」(2026-08-08 深夜)

## 二、反复修复的病根(支付系统修过多次,每次都在这几个点上)

### 病根 1:STRIPE_PRICE_* 环境变量反复漏配
- **症状**:checkout 报「套餐 X 的价格未配置」,503。
- **历史**:secret 配了、4 个 Price ID 没配 —— 反复发生(用户侧漏配)。
- **根治(PR #37)**:`src/lib/billing/price-catalog.ts` 目录自解析 —— env 有则优先,
  没有就按「产品名 + 金额 + 周期」从 Stripe 目录实时匹配。旧价 USD 39/19 正确返回
  NULL(按 free 降级,不误判)。checkout/webhook 不再被 env 卡死。
- **前提**:Vercel 的 `STRIPE_SECRET_KEY` 必须是 **sk_live_** 且属于
  `acct_1TxmnPPw7bzqE3HK`。sk_test_ 密钥会让目录解析查空测试目录,
  也打断 webhook 的 customer/subscription retrieve。
- **自诊断**:checkout 503 的 hint 里带密钥前缀(sk_live_/sk_test_/rk_live_),一眼看出模式。

### 病根 2:死路由 —— 路由活着,没有任何调用方
- **症状**:/api/billing/checkout 代码正确,但全仓库无人调用,整条安全路径是死的。
- **历史**:PR #38 把支付路径改成 Payment Link 为主,checkout 降为无人使用的后备
  → 死路由。用户 2026-08-09 ba422de 恢复:SubscribeButton 重新由 PlansSection 渲染。
- **教训**:改支付路径前先 `grep -rn "SubscribeButton" src` 确认调用方。
  主路径 = 有调用方的路径,不是「代码存在的路径」。

### 病根 3:webhook 端点事件订阅
- **症状**:钱能付、权益不升 —— checkout.session.completed 根本不到达。
- **历史**:生产端点只订阅了 4 个 account.* 默认事件,零 billing 事件。
- **修复**:端点改为「发送所有事件」(或至少 checkout.session.completed +
  customer.subscription.updated/deleted + invoice.payment_failed)。
- **验证**:`stripe webhook_endpoints list --live` 看 enabled_events 清单。

### 病根 4:空库 —— 表在,数据不在
- **症状**:权益表空 → 所有人拿不到配额;subscriptions/stripe_customers 空 = 从未交付。
- **检查**:0034 种子应产出 6 行(free/professional/enterprise ×
  workflows/monthly_agent_turns)。交付自动化的最终核对已输出该表全量内容 ——
  每次交付运行日志里看得到。
- **注意**:anon key 读不了 entitlements(策略只对 authenticated)——
  用 anon 探测看到 [] 不代表真空,以自动化日志为准。

## 三、验收清单(改动支付代码后逐条跑)

1. `curl -X POST -d '{}' /api/billing/webhook` → 400(缺签名)= secret 已配
2. `curl -X POST -d '{}' /api/billing/checkout` → 401(未登录)= 路由活着且认证在岗
3. `stripe webhook_endpoints list --live` → 端点订阅含 billing 事件
4. `stripe prices list --live` → 4 条 HKD 价格在(49/490/229/2290)
5. 登录态点订阅 → 跳 Stripe Checkout Session → 付款 → 刷新 /billing 看套餐
6. 自动化交付日志「权益表种子数据」≥ 6 行
7. 免费档用付费能力 → 402 + 升级提示(配额拦截在岗)

## 四、关键文件

- 路由:`src/app/api/billing/{checkout,webhook,portal}/route.ts`
- 支付路径:`src/components/marketing/{PlansSection,SubscribeButton}.tsx`
- 价格自解析:`src/lib/billing/{stripe,price-catalog}.ts`
- 配额守卫:`src/lib/billing/{turn-quota,quota-math,entitlements}.ts`
- 数据层:0033(订阅表)/ 0034(权益种子)/ 0035(用量计量)
