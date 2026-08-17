-- 0068 Agent Runner RPC 最小权限收口(安全修复)
--
-- 【背景】0067 的 revoke public 在 Supabase 环境未彻底生效:
--   anon/authenticated 是独立角色,不继承 public 的 revoke(生产实证,
--   role_routine_grants 显示 anon/authenticated 仍有 EXECUTE)。
--   0067 已在迁移账本,文件内追加不会重跑 —— 必须独立迁移文件。
--
-- 【影响面】无实际利用(审计:pg_stat_statements 无该 RPC 的调用记录,
--   agent_runs 无其特征 error_message;函数体从未被任何角色执行)。
--   本迁移收口权限配置,消除越权面。
--
-- 【最小权限】仅 service_role 保留 EXECUTE(Cron 扫描器经 admin client 调用);
--   anon / authenticated / public 全部收回。

revoke all on function public.recover_expired_agent_runs() from public;
revoke all on function public.recover_expired_agent_runs() from anon;
revoke all on function public.recover_expired_agent_runs() from authenticated;

-- 确认保留 service_role(幂等,重复执行无害)
grant execute on function public.recover_expired_agent_runs() to service_role;
