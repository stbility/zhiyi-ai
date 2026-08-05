-- 在**纯 PostgreSQL** 上重放 supabase/migrations/ 所需的最小引导。
--
-- 【为什么需要这个文件】
-- 迁移里用到了一批 Supabase 托管环境自带、而原生 PostgreSQL 没有的东西:
--   · auth.uid()          —— RLS 策略里出现 30 次
--   · auth.users          —— 16 处外键指向它
--   · authenticated / anon / service_role / supabase_auth_admin 四个角色
--
-- 没有它们,迁移在第一条就会失败,于是「真的跑一遍」这件事一直做不了 ——
-- 而做不了的直接后果就是漏掉整条 0012 都没人发现。
--
-- 【这是仿真,不是真的 Supabase】
-- 这里造的 auth.uid() 永远返回 NULL,auth.users 也只有最少的列。
-- 所以这套引导能验证的是**结构**:表、约束、索引、策略、授权能不能建起来,
-- 建完之后长什么样。它**验证不了**运行时行为(某条策略在某个用户身份下
-- 到底放不放行)—— 那需要真实的 GoTrue 会话。
--
-- 把边界写在这里,是为了不让人以为「CI 绿了 = RLS 一定正确」。

-- Supabase 的四个角色。NOLOGIN:这里只用来承接 GRANT,不需要能登录。
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit;
  end if;
end
$$;

create schema if not exists auth;

-- 只造迁移真正用到的列。
--
-- 全部外键都是 references auth.users(id),没有一处读别的列 ——
-- 造多了反而会掩盖「迁移其实依赖了某个我们没注意到的列」这件事。
create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- 策略里到处在用。返回 NULL 是**有意的**:
-- 这套引导只验证结构建不建得起来,不模拟任何用户身份。
-- 给一个假的返回值反而危险 —— 会让人以为策略的放行逻辑也被验证过了。
create or replace function auth.uid()
returns uuid
language sql
stable
as $$ select null::uuid $$;

grant usage on schema auth to anon, authenticated, service_role;

-- gen_random_uuid() 用得到。PostgreSQL 13 起内置,这一行只是兜底。
create extension if not exists "pgcrypto";
