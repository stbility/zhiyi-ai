-- =============================================================================
-- 修复:恢复 Supabase 认证服务所需的权限
--
-- 事故经过:
--   0002 迁移出于「收紧 SECURITY DEFINER 函数暴露面」的目的,写了
--   revoke all on function ... from public。
--   但 Supabase 的认证服务以 supabase_auth_admin 身份运行,它执行挂在
--   auth.users 上的触发器时,依赖的正是那条 PUBLIC 默认授权。
--   收走之后触发器无法执行,注册/登录返回 Database error querying schema。
--
-- 教训(重要):
--   Supabase 托管的 auth schema 及其依赖链,不应由应用侧收紧权限。
--   收紧 public schema 的函数暴露面时,必须显式把执行权授回 supabase_auth_admin,
--   否则会连带打断认证。
-- =============================================================================

grant usage on schema public to supabase_auth_admin;
grant execute on function public.handle_new_user()  to supabase_auth_admin;
grant execute on function public.touch_updated_at() to supabase_auth_admin;
grant insert, select, update on public.profiles to supabase_auth_admin;
