-- 0014 限流函数只授权给 service_role
--
-- 踩过的坑:这个函数原本建在 private schema 里,而 PostgREST 不路由
-- private —— service_role 根本调不到,限流静默失效。所以它必须在 public。
--
-- 但放在 public 就意味着 anon / authenticated 也能看见,所以要显式收回:
-- 计数是服务端的事,客户端不该能自己触发或伪造。
--
-- 这份文件是从生产库反向导出补写的。

revoke all on function public.bump_rate_limit(text, integer) from public;
revoke all on function public.bump_rate_limit(text, integer) from anon;
revoke all on function public.bump_rate_limit(text, integer) from authenticated;

grant execute on function public.bump_rate_limit(text, integer) to service_role;
