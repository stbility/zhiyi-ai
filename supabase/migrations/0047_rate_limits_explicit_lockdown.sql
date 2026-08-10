-- 0047_rate_limits_explicit_lockdown.sql
-- Security Advisor(INFO):rate_limits 启用了 RLS 但无任何策略。
--
-- 根因:rate_limits 是**服务端专用表** —— 唯一访问路径是 security definer 的
-- public.bump_rate_limit(0013),客户端(anon/authenticated)从不直接读写;
-- RLS 开启 + 零策略 = 全角色被 RLS 挡死,本就是最严姿态(双重封锁:无表权限
-- grant + RLS 拦截),Advisor 的 INFO 只是要求「确认这是有意的」。
--
-- 修复:按官方 RLS「restrictive policy」做法,把封锁**显式化**为一条拒绝策略,
-- 让意图自文档化(server-only,禁止任何客户端直接访问),同时清掉 Advisor 的
-- 「无策略」发现。DEFINER 函数以 owner(postgres)身份执行,不受 RLS 影响,
-- bump_rate_limit 读写照常。
create policy rate_limits_no_direct_access on public.rate_limits
  for all to anon, authenticated
  using (false)
  with check (false);
