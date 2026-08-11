-- 0052 权益矩阵 5 档扩展:professional_plus + team + Ent 降限
--
-- 背景:plans.ts 已升级为 5 档方案
--   Free / Professional(HK$128) / Professional Plus(HK$198) / Team(HK$388) / Enterprise(自定义)
-- 但 entitlements 表的 plan_id CHECK 仍只允许 ('free','professional','enterprise'),
-- 导致 webhook 写入 professional_plus/team 订阅时报 CHECK 约束违反。
--
-- 本迁移:
--   1. 扩展 CHECK 约束到 5 档
--   2. 补全 professional_plus 和 team 的权益种子数据
--   3. 修正 enterprise 工作流配额:从 null(不限)改为 10000(对齐页面「无限」但有合理上限)
--   4. 修正 enterprise monthly_agent_turns:从 5000 改为 null(真正不限)
--
-- 【幂等】ON CONFLICT DO NOTHING / WHERE 重跑安全;CHECK 约束先删再建(同一事务内)。
-- 【安全】纯数据+约束变更,不动函数/策略/授权。
--
-- Step 1: 扩展 plan_id CHECK 约束
alter table public.entitlements drop constraint if exists entitlements_plan_id_check;
alter table public.entitlements add constraint entitlements_plan_id_check
  check (plan_id in ('free','professional','professional_plus','team','enterprise'));

-- Step 2: 补 professional_plus 权益
--   工作流:10 / Agent 运行:4000次/月(对齐 plans.ts HK$198 档)
insert into public.entitlements (plan_id, feature, quota) values
  ('professional_plus', 'workflows',           10),
  ('professional_plus', 'monthly_agent_turns', 4000)
on conflict (plan_id, feature) do nothing;

-- Step 3: 补 team 权益
--   工作流:50 / Agent 运行:10000次/月 / 成员:3(首年包含,额外成员可加购)
--   注意:team 成员数由 memberships 表管理,entitlements 里只记录"成员额度"feature
insert into public.entitlements (plan_id, feature, quota) values
  ('team', 'workflows',           50),
  ('team', 'monthly_agent_turns', 10000),
  ('team', 'members',            3)
on conflict (plan_id, feature) do nothing;

-- Step 4: enterprise 配额修正
--   workflows: null → 10000(有上限但够用,防止无限创建拖累 DB)
--   monthly_agent_turns: 5000 → null(真正不限,企业客户需求)
update public.entitlements
   set quota = 10000
 where plan_id = 'enterprise'
   and feature = 'workflows'
   and (quota is null or quota <> 10000);

update public.entitlements
   set quota = null
 where plan_id = 'enterprise'
   and feature = 'monthly_agent_turns'
   and quota is not null;
