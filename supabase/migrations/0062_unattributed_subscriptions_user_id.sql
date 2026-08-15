-- 0062 unattributed_subscriptions 补 user_id 列(P0-6 账外表安全告警修复)
--
-- 【告警】数据库安全告警:unattributed_subscriptions 没有 user_id 列。
--   Supabase 认证用户是通过 auth.uid() UUID 来识别的,官方 RLS 模式是
--   `using (auth.uid() = user_id)` —— 账外表此前完全没有存储该 UUID 的列。
--
-- 【为什么这样修】
--   · user_id uuid references auth.users(id),**可空** —— 这张表的全部意义
--     就是「归属认不出的行」(webhook 三条归属路全失败),写入时多数行确实
--     没有用户;但「套餐判不出但归属已确认」的行是知道 user_id 的,
--     必须能落库,否则付了钱的人无法按 UUID 追到账外表。
--   · 外键列建索引(顺带清掉 Advisor 0001 unindexed foreign keys)。
--   · 显式拒绝策略 —— 与 0047(rate_limits)同款:服务端专用表,RLS 开启但
--     零策略会被 Advisor 0008(rls_enabled_no_policy)上报。把封锁显式化为
--     一条 restrictive policy,意图自文档化,同时清掉 Advisor 发现。
--     0061 的 revoke all from authenticated, anon 保留,双重封锁不变。
--
-- 【纯新增列/索引/策略】不改任何现有表、策略、授权语义。迁移纪律:
-- 已合入的 0061 不动,这里只做增量。

alter table public.unattributed_subscriptions
  add column user_id uuid references auth.users (id) on delete set null;

create index if not exists unattributed_subscriptions_user_idx
  on public.unattributed_subscriptions (user_id);

-- 服务端专用表:浏览器侧(anon/authenticated)一律拒绝直接访问。
-- 与 0047 rate_limits_no_direct_access 同一模式 ——
-- RLS 开启 + 显式拒绝策略 = Advisor 不再报「无策略」,语义不变。
create policy unattributed_subscriptions_no_direct_access
  on public.unattributed_subscriptions
  for all to anon, authenticated
  using (false)
  with check (false);

comment on column public.unattributed_subscriptions.user_id is
  '可空:归属认不出的行保持 NULL;套餐判不出但归属已确认的行,webhook 落库时写入该 UUID(认领线索)';
