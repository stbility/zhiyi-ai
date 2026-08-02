-- 0013 对话限流(定长窗口)
--
-- 放在数据库里而不是进程内存里,是因为 Vercel 会跑多个函数实例 ——
-- 内存计数各算各的,等于没限。
--
-- 计数必须在**一条语句**里完成读+加+写:分两步的话并发请求会各自读到
-- 旧值,限流被轻易绕过。所以用 insert ... on conflict do update returning。
--
-- 返回的是**自增之后**的累计次数(首次调用返回 1),
-- 因此调用方用 hits > max 判定恰好放行 max 次。
--
-- 这份文件是从生产库反向导出补写的,原本只存在于 Supabase 云端。

create table if not exists public.rate_limits (
  subject      text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (subject, window_start)
);

create index if not exists rate_limits_window_idx
  on public.rate_limits (window_start);

-- 开启 RLS 但**不建任何策略**:这是刻意的。
-- 这张表只有 service_role 会碰(它绕过 RLS),普通用户不该读到别人的计数。
-- 「开了 RLS 没有策略」= 除 service_role 外一律拒绝,正是想要的效果。
alter table public.rate_limits enable row level security;

create or replace function public.bump_rate_limit(
  p_subject text,
  p_window_seconds integer
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_hits integer;
begin
  -- 把当前时刻对齐到窗口起点
  v_window := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  -- 读 + 加 + 写必须在一条语句里完成:分两步的话并发请求会各自读到旧值,
  -- 限流被轻易绕过。
  insert into public.rate_limits (subject, window_start, hits)
  values (p_subject, v_window, 1)
  on conflict (subject, window_start)
  do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;

  -- 顺手清掉两小时前的旧窗口,不必单独跑定时任务
  delete from public.rate_limits
  where window_start < now() - interval '2 hours';

  return v_hits;
end;
$$;
