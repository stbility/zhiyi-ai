-- 0037 权益配额对齐:Pro 500 / Ent 5000(月度 Agent 额度)
--
-- 背景:落地页定价区(plans.ts)已按 2026-08-08 定价决策更新为
--   Professional「每月 500 次 Agent 额度」、Enterprise「每月 5,000 次」,
--   但 0034 里的月度配额仍是 professional=2000 / enterprise=null(不限)。
--   展示层与判断层分叉:页面宣传 500/5000,数据库放行 2000/不限 ——
--   交付大于承诺,商业模型受损,且违反「展示错了用户看得见,判断错了是越权」原则。
--
-- 本迁移把判断层对齐到页面承诺:
--   professional.monthly_agent_turns: 2000 → 500
--   enterprise.monthly_agent_turns:  null(不限) → 5000
--
-- 为什么用 UPDATE 而不是改 0034 的 INSERT:
--   0034 已进入生产账本,直接改历史迁移 = 生产与仓库漂移,
--   且 MANIFEST 的「备注 B:语句成功不等于结果正确」教训在前。
--   新迁移增量修正,CI 真实重放可验证最终状态。
--
-- 【安全模型】
--   纯 UPDATE 数据行,不动表结构、策略、函数、授权 —— 风险最低一档。
--   配额收紧:pro 从 2000 → 500、ent 从不限 → 5000,均收敛到页面承诺值。
--   已在使用的用户当月额度不会回滚(usage_metering 是累计计量,
--   下月自然按新配额生效;若需当月生效,另行评估)。
--
-- 【幂等】
--   UPDATE ... WHERE quota = 旧值 只命中尚未对齐的行 ——
--   重放安全:已对齐的行不再变化,CI 迁移重放可反复执行。

-- Pro:2000 → 500
update public.entitlements
   set quota = 500
 where plan_id = 'professional'
   and feature = 'monthly_agent_turns'
   and quota = 2000;

-- Ent:不限 → 5000
update public.entitlements
   set quota = 5000
 where plan_id = 'enterprise'
   and feature = 'monthly_agent_turns'
   and quota is null;
