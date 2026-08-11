-- 0037 权益配额对齐:新 4 档套餐 → 精确月度 Agent 额度
--
-- 背景:落地页定价区(plans.ts)已按 2026-08-08 定价决策更新,
-- 但 0034 里的月度配额仍是旧的:
--   professional:  2000 (0034 初始值,需改为 500)
--   professional_plus: 2000 (0034 缺档,需新建 4000)
--   team:          null (0034 缺档,需新建 10000)
--   enterprise:    null (0034 初始值,需改为 5000)
--
-- 本迁移把判断层对齐到页面承诺:
--   professional.monthly_agent_turns:  2000 → 500
--   professional_plus.monthly_agent_turns: 新增 4000
--   team.monthly_agent_turns:          新增 10000
--   enterprise.monthly_agent_turns:   null → 5000
--
-- 【幂等策略】
--   UPDATE ... WHERE quota = 旧值: 只命中尚未对齐的行,已对齐的不再变化
--   INSERT ... ON CONFLICT: 对缺档增量插入,已存在的行 do nothing
--   CI 迁移重放可反复执行,结果一致。
--
-- 【安全模型】纯数据行变更,不动表结构/策略/函数/授权。

-- professional: 2000 → 500
update public.entitlements
   set quota = 500
 where plan_id = 'professional'
   and feature = 'monthly_agent_turns'
   and quota = 2000;

-- enterprise: null → 5000
update public.entitlements
   set quota = 5000
 where plan_id = 'enterprise'
   and feature = 'monthly_agent_turns'
   and quota is null;

-- professional_plus: 缺档,新增 4000
insert into public.entitlements (plan_id, feature, quota) values
  ('professional_plus', 'workflows',           10),
  ('professional_plus', 'monthly_agent_turns',  4000)
on conflict (plan_id, feature) do nothing;

-- team: 缺档,新增 10000
insert into public.entitlements (plan_id, feature, quota) values
  ('team', 'workflows',           null),
  ('team', 'monthly_agent_turns', 10000)
on conflict (plan_id, feature) do nothing;
