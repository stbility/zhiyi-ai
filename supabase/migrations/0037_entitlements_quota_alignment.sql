-- 0037 权益配额对齐:五档套餐 → 精确月度 Agent 额度
--
-- 背景:落地页定价区(plans.ts)已按 2026-08-11 五档定价决策更新:
--   Free:          monthly_agent_turns = 100
--   Professional:  monthly_agent_turns = 2000
--   Professional+: monthly_agent_turns = 4000
--   Team:          monthly_agent_turns = 10000
--   Enterprise:    monthly_agent_turns = null(不限)
--
-- 【2026-08-11 修正】本迁移原为 0037_entitlements_quota_alignment(基于
-- 2026-08-08 四档定价 pro=500/ent=5000),随五档定价更新为:
--   · 约束放宽前置:0034 生产版 plan_id CHECK 只含 3 档(free/professional/
--     enterprise),INSERT professional_plus/team 会违反约束 —— 必须先放宽。
--   · 配额收敛到新页面承诺值(pro=2000,pro_plus=4000,team=10000,ent=不限)。
--
-- 【幂等策略】
--   UPDATE ... WHERE quota = 旧值: 只命中尚未对齐的行,已对齐的不再变化
--   INSERT ... ON CONFLICT: 对缺档增量插入,已存在的行 do nothing
--   DO 块存在性检查放宽约束,重放安全。
--
-- 【安全模型】数据行变更 + 约束放宽,不动策略/函数/授权。

-- 0. 放宽 plan_id CHECK(3 档 → 5 档),0034 生产版只含 3 档
do $$
begin
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
end
$$;

-- 1. professional: 2000 已是新页面承诺值,无需变更(旧版曾改为 500,已回滚)

-- 2. enterprise: null(不限)已是新页面承诺值,无需变更(旧版曾改为 5000,已回滚)

-- 3. professional_plus: 缺档,新增 4000
insert into public.entitlements (plan_id, feature, quota) values
  ('professional_plus', 'workflows',           10),
  ('professional_plus', 'monthly_agent_turns',  4000)
on conflict (plan_id, feature) do nothing;

-- 4. team: 缺档,新增 10000
insert into public.entitlements (plan_id, feature, quota) values
  ('team', 'workflows',           null),
  ('team', 'monthly_agent_turns', 10000)
on conflict (plan_id, feature) do nothing;
