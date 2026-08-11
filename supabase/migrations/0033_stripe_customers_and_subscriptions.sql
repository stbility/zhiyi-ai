-- 0033 Stripe 客户与订阅(商业闭环第一步)
--
-- 产品需求第五章:Free / Professional / Enterprise 三档订阅。
-- 这是 P0 商业链的第一块 schema:订阅状态落库。
--
-- 为什么是两张表而不是一张:
--   stripe_customers 是「Stripe 侧客户 ID 与本站用户的映射」—— 一用户一客户,
--   生命周期与用户绑定,建一次基本不变。
--   subscriptions 是「当前订阅」—— 会随升级/降级/取消变化,一条记录代表
--   一个订阅期。合成一张表的话,客户映射被订阅记录反复重写。
--
-- 【安全模型】
--   · 读:仅本人(RLS using user_id = auth.uid())
--   · 写:仅 service_role —— 订阅状态只能由 webhook(验签后)写入,
--     用户自己改状态 = 伪造权益,这条路径必须封死。
--   · 订阅状态是权益判断的唯一事实来源,不信任客户端传来的任何 plan 字段。
--
-- 【纯新增】不改任何现有表、策略、授权。与 0030/0031 同类,风险最低一档。

-- Stripe 客户映射:本站 user_id ↔ Stripe customer_id
create table if not exists public.stripe_customers (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  customer_id   text not null unique,
  -- 最近一次从 Stripe 同步的时间。排查「为什么订阅没生效」时,
  -- 先看这个字段是不是旧的 —— 旧 = webhook 没到或验签失败
  updated_at    timestamptz not null default now()
);

alter table public.stripe_customers enable row level security;

-- 本人可见自己的客户映射。密文不在其中,非敏感
create policy stripe_customers_select_own on public.stripe_customers
  for select to authenticated
  using (user_id = (select auth.uid()));

-- 订阅:一条记录 = 一个订阅期。状态机由 Stripe webhook 驱动
create table if not exists public.subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  -- Stripe subscription_id。幂等去重的依据 —— 同一订阅的重复 webhook
  -- 事件必须只生效一次
  stripe_subscription_id text not null unique,
  -- 权益判断只认这几个状态。trialing 有试用额度,active 是正式,
  -- 其余( past_due / canceled / unpaid / incomplete )一律按无权益处理,
  -- 用 check 约束锁死 —— 别让脏数据混进来
  status              text not null
    check (status in ('active','trialing','past_due','canceled','unpaid','incomplete','paused','incomplete_expired')),
  -- plan_id 对齐 plans.ts 的 PlanId: free / professional / professional_plus / team / enterprise。
  -- 由 webhook 从 Stripe Price 的 metadata.plan_id 映射而来,
  -- 不在客户端传 —— 客户端说自己是 enterprise 不算数
  plan_id             text not null
    check (plan_id in ('free','professional','professional_plus','team','enterprise')),
  current_period_end  timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists subscriptions_user_idx
  on public.subscriptions (user_id);

alter table public.subscriptions enable row level security;

-- 本人可见自己的订阅。展示用,不含任何写路径
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated
  using (user_id = (select auth.uid()));
