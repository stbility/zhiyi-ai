-- 0061 付款归属失败账外表(P0-6)
--
-- 【背景】webhook 归属订阅的三条路(metadata.userId → stripe_customers →
-- 邮箱反查)全部失败且订阅行不存在时,此前直接 throw 吃 5xx 让 Stripe
-- 重试 —— 重试到放弃后**付款与权益永久丢失,用户与管理员均无感知**。
--
-- 【方案】归属失败不再死循环重试:事件落本表留痕(含付款邮箱),返回 200,
-- 由人工凭邮箱补录(见 docs/payment-loop-runbook.md 认领章节)。
--
-- 【纯新增】不改任何现有表、策略、授权。
-- 安全:本表只给 service_role 使用,authenticated/anon 一律无权读写。

create table if not exists public.unattributed_subscriptions (
  stripe_subscription_id text primary key,
  customer_id           text not null,
  customer_email        text,
  plan_id               text not null default 'unknown',
  status                text not null,
  last_event            text,
  attempts              integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists unattributed_subscriptions_email_idx
  on public.unattributed_subscriptions (customer_email);

alter table public.unattributed_subscriptions enable row level security;

-- 仅 service_role(admin 客户端)可访问;浏览器侧完全关闭
revoke all on public.unattributed_subscriptions from authenticated, anon;

comment on table public.unattributed_subscriptions is
  '付款归属失败账外表:webhook 无法把订阅落到用户时留痕,人工凭付款邮箱认领';
