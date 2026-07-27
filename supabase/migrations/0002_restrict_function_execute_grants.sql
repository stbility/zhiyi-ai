-- =============================================================================
-- Phase 1 · 收紧 SECURITY DEFINER 函数的执行权限
--
-- 由 Supabase 安全顾问(database linter)实测发现:0001 建立的四个函数全部可以
-- 被任何人通过 REST API 直接调用 —— /rest/v1/rpc/<function_name>。
--
-- 成因:Postgres 新建函数默认授予 PUBLIC 执行权,而 Supabase 把 public schema
-- 暴露为 REST API。0001 里只对 is_org_member / has_org_role 做了 revoke,
-- 漏掉了两个触发器函数。
-- =============================================================================

-- 触发器函数:只应由触发器调用,对外暴露没有任何正当用途。
-- 触发器的执行不受 EXECUTE 授权影响,收回不会影响功能。
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

-- 权限判定函数:必须保留 authenticated 的执行权。
-- RLS 策略表达式在调用者上下文中求值,缺少 EXECUTE 会让策略直接报错。
--
-- 保留这一项后,安全顾问仍会就「登录用户可调用 SECURITY DEFINER 函数」告警。
-- 这是经过权衡后接受的:这两个函数只能回答「我自己是不是某组织的成员 / 有没有
-- 某角色」,而这恰恰是调用者查自己的 memberships 就能得到的信息,不构成越权泄露。
-- 匿名角色没有任何理由调用它们,一律收回。
revoke all on function public.is_org_member(uuid) from public, anon;
revoke all on function public.has_org_role(uuid, public.org_role[]) from public, anon;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.has_org_role(uuid, public.org_role[]) to authenticated;
