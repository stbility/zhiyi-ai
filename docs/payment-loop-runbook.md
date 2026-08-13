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

- webhook 路由已有**真实执行**的测试:`tests/app/billing-webhook-handler.test.ts`
  (19 例,替身 Stripe + 内存版 Supabase,真正调用 `POST()`)。含病根 5 的回归测试 ——
  已验证:把修复回退后这些用例会变红(`expected 'active' to be 'canceled'`)。
- **真实 HMAC 签名校验**已被执行:`tests/app/billing-webhook-signature.test.ts`
  (8 例)。用官方 `webhooks.generateTestHeaderString()` 造真签名,
  路由里的 `constructEvent()` 做真校验。覆盖:正确签名放行、请求体被篡改拒绝、
  错误 secret 拒绝、时间戳过期拒绝。**签名校验是这个端点唯一的身份守卫** ——
  它若失效,任何人都能 POST 一个 `subscription.updated` 把自己升成 enterprise。

**已在真实 Stripe(test 账本)上验证过的事(2026-08-09)**:

- 走通了一笔**真实测试卡付款**,发票 `paid`,订阅 `active`。(旧版价格记录,已归档)
- **webhook 读取的 9 项字段假设,对着真实订阅对象逐条核对,9/9 通过**。
  其中两条是 v22 破坏性变更的要害,现在有真实证据:
  `current_period_end` **在** `items.data[0]` 上,订阅顶层**没有**这个字段。
- 病根 1 的目录自解析曾在真实目录验证过(四条 HKD 价格都解析得出、反向映射对、
  互不重复)——**该机制已于 2026-08-10 删除(#54):「不配 id 也能跑」是错误做法,
  官方做法 = STRIPE_PRICE_* 显式配置,未配如实 503 降级。** 相关 live 测试随删。
- Golden fixture `tests/fixtures/stripe-subscription.test-mode.json` 来自真实对象,
  不是手造的。Stripe 再做一次 v22 式的字段搬迁,它就会红。

**尚未证实的事**:

- **webhook → 数据库这一段仍未在真实链路上跑过**。本机没装 docker,也没装
  supabase CLI,起不了本地 Supabase;而拿生产库跑测试支付会把测试订阅写进
  生产数据、给真实用户发放权益,不能做。DB 段目前靠内存版 Supabase 的
  执行级测试覆盖(27 例),逻辑可信,但不等于生产环境跑过。
- checkout / portal 两个路由仍**没有执行级测试**。
- checkout 创建 Stripe 客户**没有 Idempotency-Key**,且是「先查后建」竞态。
- 生产(live)库 `subscriptions=0` / `stripe_customers=0`,且 **live 侧体检尚未跑**
  —— 生产为什么没跑通,这一步才是答案。
- 提醒:此前 935 个绿灯里,支付部分**全部是静态源码断言** —— `readFileSync`
  读 SQL 再 `toContain`。那种绿灯连病根 5 这种会漏钱的缺陷都发现不了。

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
- **根治(2026-08-10 终版)**:`STRIPE_PRICE_*` 显式配置(官方做法),缺失时
  checkout 如实 503 → 前端降级 Payment Link;webhook 判不出套餐如实 500 重试,
  绝不静默降级 free(付钱权益不升 = 断链病根)。曾用「目录自解析」(PR #37,
  price-catalog)容忍漏配 —— 被判定错误做法,随 #54 删除。
- **前提**:Vercel 的 `STRIPE_SECRET_KEY` 必须是 **sk_live_** 且属于当前 Stripe 账号
  (旧账号 acct_1TxmnPPw7bzqE3HK 已于 2026-08-10 删除,新账号重建中)。
  sk_test_ 密钥会查空测试目录,也打断 webhook 的 customer/subscription retrieve。
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

### 病根 5:信任事件载荷 —— 乱序事件让已取消的订阅复活(2026-08-09 修复)

- **症状**:用户退订后**永久保留付费权益**,库里状态是 `active`,且再无事件纠正。
  最隐蔽的一种:不报错、不告警、测试全绿,只有对账时才发现少收钱。
- **病根**:官方文档 `/webhooks`「Event ordering」明说
  **"Stripe doesn't guarantee the delivery of events in the order that they're
  generated."** 而 `created/updated` 分支此前直接把 `event.data.object`
  的 status 写库。一条**更早生成、延迟送达**的 `updated`(载荷 `active`)
  到达时,会覆盖掉 `deleted` 已经写好的 `canceled`。
- **同源的第二个洞**:`deleted` 分支用的是 update-only 且不看命中行数 ——
  若 `deleted` 比 `created` 先到,update 匹配 0 行、不报错、不重试,取消永久丢失。
- **修复**:所有订阅事件分支(created/updated/paused/resumed/deleted)统一
  `stripe.subscriptions.retrieve()` **拉权威状态**,载荷只用于取 id;
  拉取失败抛错吃 5xx 让 Stripe 重试,绝不退回去写可能过期的载荷。
  `deleted` 改走同一条 upsert 路径,行不存在时建行而非静默丢弃。
  顺带补上 `paused` / `resumed` 两个此前缺失的分支(0033 白名单里有 `paused`)。
- **守卫**:`tests/app/billing-webhook-handler.test.ts` 的「【P0 回归】事件乱序」
  一组。**这些用例只在乱序时才红 —— 真实支付测试大概率碰不到这个 bug**,
  这正是它必须有执行级测试的理由。
- **残留窗口(已知)**:两条事件并发处理时,各自拉到的快照仍可能后写覆盖先写。
  窗口从「投递延迟(可达数小时)」缩到「并发处理(毫秒级)」。
  要彻底消除需在 `subscriptions` 加事件时间戳列做单调守卫(需迁移)。

## 三、验收清单(改动支付代码后逐条跑)

0. **先跑只读体检**:`bash scripts/stripe-audit.sh` —— 一次看全 Stripe 侧四项
   (密钥模式 / 价格目录 / webhook 事件订阅 / 历史订阅与结账事件)。
   下面 1、2 两条应用侧自证只能说明「守卫在岗」,**说明不了钱能不能变成权益**。
1. `curl -X POST -d '{}' /api/billing/webhook` → 400(缺签名)= secret 已配
2. `curl -X POST -d '{}' /api/billing/checkout` → 401(未登录)= 路由活着且认证在岗
3. `stripe webhook_endpoints list --live` → 端点订阅含 billing 事件
4. `stripe prices list --live` → 4 条 HKD 价格在(128/198/388 + Enterprise 自定义)
5. 登录态点订阅 → 跳 Stripe Checkout Session → 付款 → 刷新 /billing 看套餐
6. 自动化交付日志「权益表种子数据」≥ 6 行
7. 免费档用付费能力 → 402 + 升级提示(配额拦截在岗)

## 四、关键文件

- 路由:`src/app/api/billing/{checkout,webhook,portal}/route.ts`
- 支付路径:`src/components/marketing/{PlansSection,SubscribeButton}.tsx`
- 价格解析:`src/lib/billing/stripe.ts`(env-only,STRIPE_PRICE_*)
- 配额守卫:`src/lib/billing/{turn-quota,quota-math,entitlements}.ts`
- 数据层:0033(订阅表)/ 0034(权益种子)/ 0035(用量计量)
- **只读体检**:`scripts/stripe-audit.sh`(2026-08-09 ce111ea 新增)——
  全部是 GET,不创建 / 不修改 / 不删除任何 Stripe 对象,不打印密钥
  (只打印前 8 位模式前缀)。改支付代码前后都应跑一次。
- **test 模式目录种子**:`scripts/stripe-test-seed.sh` —— 幂等地建出 4 条
  HKD 价格(带 `metadata.plan_id`)。**检测到 live 密钥直接拒绝退出**。
  为什么需要它:Stripe 的 test mode 是**完全独立的命名空间**,live 已有的
  产品和价格在 test 里一条都不存在(2026-08-09 实测:test 侧 active 价格 0 条)。
  模拟支付跑不起来的第一个原因通常就是这个,而且很容易误判成「代码有问题」。
- **执行级测试**:`tests/app/billing-webhook-handler.test.ts`(业务分支)、
  `tests/app/billing-webhook-signature.test.ts`(真实 HMAC)、
  `tests/helpers/supabase-memory.ts`(内存版 Supabase,两者共用)、
  `tests/fixtures/stripe-subscription.test-mode.json`(真实对象 golden fixture)。
- **真实目录冒烟**:`tests/live/stripe-catalog-resolve.test.ts`
  (`pnpm test:live`;无 test 密钥时跳过而非红)。

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

## 十、归属失败账外表人工认领(P0-6,2026-08-13)

**背景**:webhook 三条归属路(metadata.userId → stripe_customers → 邮箱反查)
全部失败且订阅行不存在时,此前 throw 让 Stripe 重试到放弃 —— 付款与权益
永久丢失且无人知晓。现在事件落 `unattributed_subscriptions` 表(仅 service_role
可读写),返回 200,人工凭付款邮箱补录。

**什么时候该看这张表**:
- 收到 webhook error 日志「订阅归属失败,已入账外表待人工认领」
- 用户反馈「付了钱但没开通」(排查路径:先查这张表,再查 Stripe 事件)

**认领流程**:
1. 查账外表(在 Supabase SQL Editor 用 service_role 或 psql):
   ```sql
   select stripe_subscription_id, customer_email, plan_id, status, attempts, created_at
   from public.unattributed_subscriptions
   order by created_at desc;
   ```
2. 用付款邮箱在 auth.users 里找到对应用户(邮箱不一致时先与用户确认身份):
   ```sql
   select id, email from auth.users where lower(email) = lower('<付款邮箱>');
   ```
3. 补录订阅(以 Stripe 侧真实状态为准,先 `stripe.subscriptions.retrieve` 核对):
   ```sql
   insert into public.subscriptions
     (user_id, stripe_subscription_id, status, plan_id, current_period_end)
   values
     ('<user_id>', '<stripe_subscription_id>', '<status>', '<plan_id>', '<period_end>')
   on conflict (stripe_subscription_id) do update
     set status = excluded.status, plan_id = excluded.plan_id;
   ```
4. 补录客户映射(后续事件可直接归户):
   ```sql
   insert into public.stripe_customers (user_id, customer_id)
   values ('<user_id>', '<customer_id>')
   on conflict (user_id) do update set customer_id = excluded.customer_id;
   ```
5. 标记已认领(删除该行,或人工记一笔):
   ```sql
   delete from public.unattributed_subscriptions
   where stripe_subscription_id = '<stripe_subscription_id>';
   ```
6. 在 system_logs 留痕:`insert into public.system_logs (organization_id, actor_id, level, event, message) ...`
   (或至少记一笔人工日志)。

**提醒**:补录是**人工豁免路径**,写者纪律(0033:subscriptions 唯一写入方 =
webhook)在此被人工操作豁免 —— 每次补录必须在日志留痕,并在每周体检时
复盘「为什么又出现归属失败」(通常是 Payment Link 邮箱与注册邮箱不一致,
根治方向是引导用户走登录态 checkout)。
