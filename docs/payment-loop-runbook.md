# 支付闭环运行手册(订阅 → 支付 → 解锁 → 交付)

> 本文件记录智一 AI 支付闭环的**真实状态、反复修复的病根与验证方法**。
> 每次动支付代码前先读它 —— 这个闭环已经修过很多次,病根都是同一个模式:
> **代码认为「配置好了」,生产实际没有;或者路由活着,却没有任何调用方。**

## 〇、当前验证状态(2026-08-09 05:00 核验,只读)

**一句话:代码与契约对齐,但闭环从未被端到端走通过一次。**

已证实为真:

- `pnpm typecheck` 零错误;`pnpm test` 98 个测试文件 / 935 个用例全绿。
- webhook 安全姿态成立:subscriptions 表只由 webhook 写、套餐只认 Price 上的
  `metadata.plan_id` 白名单、不信客户端传的 plan、按 `stripe_subscription_id`
  幂等 upsert(重放安全)。
- 4 笔支付修复提交已推送,`main` 与 `origin/main` 一致。

**尚未证实、且容易被绿色测试掩盖的事**:

- 支付相关测试**全部是静态源码断言** —— `readFileSync` 读迁移 SQL 与 `plans.ts`,
  再 `expect(...).toContain(...)`。全仓库搜索 `vi.mock stripe` / `new Stripe` /
  `stripe.checkout` / `constructEvent` **零命中**;搜索测试是否 import 过
  `src/app/api/*` 的路由处理函数**零命中**。
  → 即 checkout / webhook / portal 三个路由的实际代码,**从未被任何测试执行过一行**。
- 生产库 `subscriptions=0` / `stripe_customers=0`。
- 因此:**既没有真实支付,也没有 test mode 模拟支付**。935 绿灯证明的是
  「源码里写了这些字符串」,不是「钱能变成权益」。

**当前卡点**:`scripts/stripe-audit.sh` 尚未运行,Stripe 侧四件事全部未知 ——
密钥是 live 还是 test、四条 HKD 价格在不在、webhook 端点订阅了哪些事件、
历史上有没有过结账事件。这四件应用侧一律看不见(见第五节)。

> **写给下一个改这里的人**:不要把「测试全绿」当成「闭环跑通」。
> 这份文件第二节的四个病根,没有一个能被现有的静态测试发现。

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

0. **先跑只读体检**:`bash scripts/stripe-audit.sh` —— 一次看全 Stripe 侧四项
   (密钥模式 / 价格目录 / webhook 事件订阅 / 历史订阅与结账事件)。
   下面 1、2 两条应用侧自证只能说明「守卫在岗」,**说明不了钱能不能变成权益**。
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
- **只读体检**:`scripts/stripe-audit.sh`(2026-08-09 ce111ea 新增)——
  全部是 GET,不创建 / 不修改 / 不删除任何 Stripe 对象,不打印密钥
  (只打印前 8 位模式前缀)。改支付代码前后都应跑一次。

## 五、为什么应用侧自证不够(体检脚本存在的理由)

应用侧能自证的只有两件事:「webhook 端点会拒绝无签名请求」「checkout 未登录会 401」。
真正决定钱能不能变成权益的四件事全在 Stripe 那边,**应用侧一律看不见**:

1. **密钥是 live 还是 test** —— test 密钥查的是空目录,价格永远解析不出来。
2. **四条价格在不在、金额对不对、有没有 `metadata.plan_id`** —— 缺 metadata 会让
   webhook 认不出套餐。
3. **webhook 端点登记了没有、订阅了哪些事件** —— 这条最阴:端点只订阅默认的
   `account.*` 事件时,付款会成功而权益永不解锁,**而且从应用侧完全看不出来**——
   签名守卫照常返回 400,一切看起来正常。
4. **Stripe 那边到底有没有过订阅 / 结账事件** —— 有记录而库里没有 =
   收了钱没交付,最坏的一种。

对照基准:生产库当前 `subscriptions=0` / `stripe_customers=0`。
体检第 5 节若有订阅或事件 → 钱收到了但没落库(投递或归属问题);
若是 0 → 从来没人付过款,闭环还没被走过一次。
