-- 0035 用量计量(Usage Metering)
--
-- 商业闭环第四步:把「限流」升级为「额度」。
--
-- 与 rate_limits(0013)的分工:
--   rate_limits 是**短窗限流** —— 防跑飞的脚本(每分钟 20 次等),
--   计数窗口 1 小时,到期即清。
--   usage_metering 是**月度计量** —— 记「这个月用了多少额度」,
--   与 entitlements 的 monthly_agent_turns 对照,超额降级或提示。
--   两者并存:限流管爆发,计量管总量。
--
-- 为什么按 (user_id, period_month) 聚合而不是每行一条调用:
--   计量是「本月累计」语义,upsert 计数比 append-only 省一个量级
--   的行数(agent 一步一行 vs 每月一行)。审计粒度由 agent_steps 承担。
--
-- 【纯新增】不改现有表策略。风险最低一档。

-- 月度用量。period_month 用 'YYYY-MM' 文本 —— 比 timestamptz 好聚合,
-- 时区歧义也少(按 UTC 记账,跨月线清晰)
create table if not exists public.usage_metering (
  user_id       uuid not null references auth.users (id) on delete cascade,
  period_month  text not null check (period_month ~ '^\d{4}-\d{2}$'),
  category      text not null
    check (category in ('agent_turns', 'rag_queries', 'storage_mb')),
  units         integer not null default 0 check (units >= 0),
  updated_at    timestamptz not null default now(),
  primary key (user_id, period_month, category)
);

alter table public.usage_metering enable row level security;

-- 本人可见自己的用量(展示 UsageMeter 用)。写只走 service_role RPC
create policy usage_metering_select_own on public.usage_metering
  for select to authenticated
  using (user_id = (select auth.uid()));

-- 计数:读+加+写一条语句完成,并发安全(与 0013 bump_rate_limit 同法)
create or replace function public.bump_usage(
  p_user_id uuid,
  p_category text,
  p_units integer default 1
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month text := to_char(now() at time zone 'UTC', 'YYYY-MM');
  v_total integer;
begin
  insert into public.usage_metering (user_id, period_month, category, units)
  values (p_user_id, v_month, p_category, p_units)
  on conflict (user_id, period_month, category)
  do update set units = public.usage_metering.units + excluded.units,
                updated_at = now()
  returning units into v_total;

  return v_total;
end;
$$;

-- 查询本月用量。与 bump_usage 对称,读也走函数(服务端统一入口)
create or replace function public.get_monthly_usage(
  p_user_id uuid,
  p_category text default null
) returns table (category text, units integer)
language sql
stable
security definer
set search_path = ''
as $$
  select u.category, u.units
  from public.usage_metering u
  where u.user_id = p_user_id
    and u.period_month = to_char(now() at time zone 'UTC', 'YYYY-MM')
    and (p_category is null or u.category = p_category);
$$;

-- EXECUTE 只给 authenticated,service_role 天然可调
revoke execute on function public.bump_usage(p_user_id uuid, p_category text, p_units integer) from public, anon;
grant execute on function public.bump_usage(p_user_id uuid, p_category text, p_units integer) to authenticated;
revoke execute on function public.get_monthly_usage(p_user_id uuid, p_category text) from public, anon;
grant execute on function public.get_monthly_usage(p_user_id uuid, p_category text) to authenticated;
