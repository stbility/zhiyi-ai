-- 0049_clear_overlapping_policies.sql
-- Performance Advisor「多项宽松政策」11 条告警(2026-08-10)根治。
--
-- 根因:生产库保留 0012 合并前的旧策略(0012 在生产未生效 = 漂移,0048 头
-- 注释已实证),与合并后策略同 role+action 并存 → 每条查询要逐条求值所有
-- permissive 策略,Advisor 报 11 条。重放库(CI)因 0012 已执行而干净,
-- 所以 CI 全绿看不到 —— 又一处「CI 全绿 ≠ 生产」。
--
-- 语义安全:每条被删策略的有效权限都被保留策略的 OR 表达式完全覆盖:
--   · ai_models/providers_write_admin(FOR ALL) → select_member(is_org_member
--     含 owner/admin)+ insert/update/delete_admin —— admin 是成员,读权不丢
--   · profiles_select_self/select_org_peers → select_visible(id=self OR 同组)
--   · organizations_select_creator/select_member → select_visible(created_by
--     =self OR is_org_member)
--   · memberships_insert_admin/insert_creator_bootstrap → insert_allowed
--     (has_org_role OR 引导 bootstrap)
-- 0012 头部明言「合并前后有效权限相同」。drop if exists = 重放库无副作用
-- (策略本就不存在),生产库精准清除残留。

drop policy if exists ai_models_write_admin on public.ai_models;
drop policy if exists ai_providers_write_admin on public.ai_providers;

drop policy if exists profiles_select_self on public.profiles;
drop policy if exists profiles_select_org_peers on public.profiles;

drop policy if exists organizations_select_creator on public.organizations;
drop policy if exists organizations_select_member on public.organizations;

drop policy if exists memberships_insert_admin on public.memberships;
drop policy if exists memberships_insert_creator_bootstrap on public.memberships;

-- 核对(生产库应用后应全部返回 0 行):
--   select policyname from pg_policies where schemaname='public'
--     and policyname in ('ai_models_write_admin','ai_providers_write_admin',
--       'profiles_select_self','profiles_select_org_peers',
--       'organizations_select_creator','organizations_select_member',
--       'memberships_insert_admin','memberships_insert_creator_bootstrap');
