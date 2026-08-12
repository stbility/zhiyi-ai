-- 0057 system_logs 写入策略收紧(2026-08-12)
--
-- Supabase Advisor 告警:0056 的 system_logs_insert_authenticated 用
-- with check (true) 允许任何登录用户向 system_logs 无限制插入
-- (可伪造任意 organization_id 的行)。
--
-- 收紧:只能向**自己所在组织**的日志插入(经 private.is_org_member),
-- 系统级(organization_id is null)不再允许客户端写入 ——
-- 系统级事件由服务端/Worker 以服务身份落库,不暴露给客户端。
--
-- 迁移纪律:已合入的 0056 不改,这里 drop + recreate。

drop policy if exists system_logs_insert_authenticated on public.system_logs;

create policy system_logs_insert_member on public.system_logs
  for insert to authenticated
  with check (
    organization_id is not null
    and private.is_org_member(organization_id)
  );
