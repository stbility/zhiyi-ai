-- 0052 新增套餐权益初始行:professional_plus / team
--
-- 背景:0034 建表时只有 free/professional/enterprise 三档,CHECK 约束也只有这三值。
-- 0034 已进入生产账本,不能改其 INSERT(改历史迁移 = 生产与仓库漂移)。
-- 本迁移独立插入新档位初始数据,幂等设计,重放安全。
--
-- 同时修正 enterprise.monthly_agent_turns 从 null(不限) → 5000,
-- 对齐 0037 的对齐意图(0037 因 CHECK 限制未能完成该修正)。
--
-- 【幂等】INSERT ... ON CONFLICT DO NOTHING:
--   行已存在 → no-op;行不存在 → 插入。反复重放安全。
--
-- 【约束扩展】先扩展 CHECK,后插入数据:
--   若 CHECK 仍是旧值(0034 未修改的仓库 clone),插入会报约束错误 ——
--   这是正常的,说明该 clone 尚未同步 0034 修改,需先拉取最新迁移。
--   CI 跑本迁移前会先 apply 0034 的 CHECK 扩展,保证顺序正确。

-- 1. 扩展 CHECK 约束(已在 0034 修改过的环境此步是 no-op)
alter table public.entitlements
  drop constraint if exists entitlements_plan_id_check,
  add constraint entitlements_plan_id_check
    check (plan_id in ('free','professional','professional_plus','team','enterprise'));

-- 2. 插入/修正各档位月度额度(对齐 0037 的对齐目标)
--    professional: 500(0037 已修正,此行幂等)
insert into public.entitlements (plan_id, feature, quota) values
  ('professional', 'monthly_agent_turns', 500)
on conflict (plan_id, feature) do nothing;

--    enterprise: null → 5000(0037 尝试做但被 CHECK 挡住)
update public.entitlements
   set quota = 5000
 where plan_id = 'enterprise'
   and feature = 'monthly_agent_turns'
   and quota is distinct from 5000;

-- 3. 插入新档位初始行(idempotent)
insert into public.entitlements (plan_id, feature, quota) values
  ('professional_plus', 'workflows',           10),
  ('professional_plus', 'monthly_agent_turns', 2000),
  ('team',              'workflows',           30),
  ('team',              'monthly_agent_turns',  5000)
on conflict (plan_id, feature) do nothing;
