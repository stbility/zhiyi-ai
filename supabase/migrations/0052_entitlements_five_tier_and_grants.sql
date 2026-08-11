-- 0052 权益五档化 + 函数授权修复
--
-- 症状(2026-08-11):生产 entitlements 表是 0034 原始 3 档(free/professional/
-- enterprise),0037 的 INSERT professional_plus/team 违反 CHECK 约束会失败,
-- 导致 0036-0051 全部卡在「待应用」,五档定价永远无法落地。
--
-- 本迁移做三件事:
-- A. 放宽 entitlements 与 subscriptions 的 plan_id CHECK 约束(3 档 → 5 档)
-- B. upsert 全部 5 档默认权益(对齐新版落地页 2026-08-11):
--      Free:         workflows=1,   monthly_agent_turns=100
--      Professional: workflows=5,   monthly_agent_turns=2000
--      Professional+: workflows=10, monthly_agent_turns=4000
--      Team:         workflows=null(不限), monthly_agent_turns=10000
--      Enterprise:   workflows=null(不限), monthly_agent_turns=null(不限)
-- C. 重建 get_entitlements/bump_usage/get_monthly_usage 的 EXECUTE 授权
--    (0046 改 security invoker 后的完整性兜底,幂等)
--
-- 【幂等】DO 块 + 存在性检查,重放安全。

begin;

-- ── A. 放宽 plan_id CHECK 约束(3 档 → 5 档)────────────────────────
-- 约束名是 PostgreSQL 自动生成的表名_列名_check,存在性检查保证幂等。
do $$
begin
  -- entitlements 表
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.entitlements'::regclass
      and conname = 'entitlements_plan_id_check'
      and pg_get_constraintdef(oid) not like '%professional_plus%'
  ) then
    alter table public.entitlements drop constraint entitlements_plan_id_check;
    alter table public.entitlements add constraint entitlements_plan_id_check
      check (plan_id in ('free','professional','professional_plus','team','enterprise'));
  end if;

  -- subscriptions 表
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.subscriptions'::regclass
      and conname = 'subscriptions_plan_id_check'
      and pg_get_constraintdef(oid) not like '%professional_plus%'
  ) then
    alter table public.subscriptions drop constraint subscriptions_plan_id_check;
    alter table public.subscriptions add constraint subscriptions_plan_id_check
      check (plan_id in ('free','professional','professional_plus','team','enterprise'));
  end if;
end
$$;

-- ── B. 五档默认权益(upsert,保留已有行,补齐缺档)──────────────────
insert into public.entitlements (plan_id, feature, quota) values
  ('free',              'workflows',            1),
  ('free',              'monthly_agent_turns',  100),
  ('professional',      'workflows',            5),
  ('professional',      'monthly_agent_turns',  2000),
  ('professional_plus', 'workflows',            10),
  ('professional_plus', 'monthly_agent_turns',  4000),
  ('team',              'workflows',            null),
  ('team',              'monthly_agent_turns',  10000),
  ('enterprise',        'workflows',            null),
  ('enterprise',        'monthly_agent_turns',  null)
on conflict (plan_id, feature) do update set quota = excluded.quota;

-- ── C. RPC 授权重建(幂等)──────────────────────────────────────────
revoke execute on function public.get_entitlements(uuid) from public, anon;
grant execute on function public.get_entitlements(uuid) to authenticated;

revoke execute on function public.bump_usage(uuid, text, integer) from public, anon;
grant execute on function public.bump_usage(uuid, text, integer) to authenticated;

revoke execute on function public.get_monthly_usage(uuid, text) from public, anon;
grant execute on function public.get_monthly_usage(uuid, text) to authenticated;

commit;
