-- 0052 entitlements 数据重建 + 函数授权修复
--
-- 症状(2026-08-11):生产 entitlements 表空 → 所有用户 get_entitlements RPC
-- 返回空数组 → 被判定为 free plan → 五档定价完全不生效。
--
-- 根因分析:
-- 1. entitlements 表的 insert 走的是 if not exists语义(on conflict do nothing),
--    如果首次执行时 CHECK 约束尚未加入 professional_plus/team,
--    insert 会静默失败(entitlements 表空)。
-- 2. 0046 把 get_entitlements 等函数从 security definer 改 invoker,
--    REVOKE/GRANT 链可能未完整重放,导致 RPC 权限被回收。
--
-- 修复:
-- A. 删除旧数据(如果有脏数据)后重新插入全部 5 档默认权益
-- B. 重建 get_entitlements 的 EXECUTE 授权(确保 authenticated 可调用)
-- C. 幂等:DELETE + 完整 INSERT,不怕重放
--
-- 【警告】这是 P0 生产修复,不允许失败。执行前请确认在事务中。

begin;

-- A. 清理旧权益数据(确保干净状态)
delete from public.entitlements;

-- 全部 5 档套餐的默认权益(对齐新版落地页 2026-08-11):
--   Free:        1个工作流, 100次/月
--   Professional: 5个工作流, 2000次/月
--   Professional+: 10个工作流, 4000次/月
--   Team:        不限工作流, 10000次/月
--   Enterprise:  不限
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
  ('enterprise',        'monthly_agent_turns',  null);

-- B. 重建 RPC 函数授权(0046 改 invoker 后的完整性兜底)
--    如果授权已存在,revoke+grant 是幂等的。
revoke execute on function public.get_entitlements(uuid) from public, anon;
grant execute on function public.get_entitlements(uuid) to authenticated;

revoke execute on function public.bump_usage(uuid, text, integer) from public, anon;
grant execute on function public.bump_usage(uuid, text, integer) to authenticated;

revoke execute on function public.get_monthly_usage(uuid, text) from public, anon;
grant execute on function public.get_monthly_usage(uuid, text) to authenticated;

-- C. 验证插入
-- 预期: 10 行(free+professional+professional_plus+team+enterprise 各 2 个 feature)
assert (select count(*) from public.entitlements) = 10;

commit;
