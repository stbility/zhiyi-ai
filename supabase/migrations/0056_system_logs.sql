-- 0056 system_logs 结构化日志(阶段 8,2026-08-12)
--
-- 背景:README「尚未交付」最后一项里的结构化日志 —— 此前关键事件
-- (工作流运行、智能体运行、支付回调、Worker 执行)没有统一落点,
-- 排查只能靠 Vercel 日志(平台 72h 滚动,不可检索,不可留痕)。
--
-- 设计:
--   · 一行一事件,level 分级(info/warn/error)
--   · organization_id 可空(系统级事件如支付回调无组织上下文)
--   · meta jsonb 存结构化细节(不塞进 message 拼字符串)
--   · RLS:成员可写(自己的事件)、组织 admin 可读、系统级事件任何人不可读
--     (只经 Vercel 日志)—— 不把敏感细节暴露给前端
--   · 容量:只保留 30 天(Vercel Cron 每日清理,见 /api/workflow/worker
--     同一兜底通道) —— 日志是排查用的,不是审计归档,30 天够回溯。

create table if not exists public.system_logs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  level           text not null default 'info' check (level in ('info','warn','error')),
  event           text not null check (char_length(event) between 1 and 80),
  actor_id        uuid references auth.users(id),
  message         text not null check (char_length(message) between 1 and 500),
  meta            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists system_logs_org_created_idx
  on public.system_logs (organization_id, created_at desc);
create index if not exists system_logs_level_created_idx
  on public.system_logs (level, created_at desc);

alter table public.system_logs enable row level security;

-- 写入:任何已登录成员可写(日志是低信任写、高信任读的场景)
create policy system_logs_insert_authenticated on public.system_logs
  for insert to authenticated
  with check (true);

-- 读取:仅组织 admin(private.has_org_role,数组参数),非敏感字段;普通成员不可读
create policy system_logs_select_admin on public.system_logs
  for select to authenticated
  using (
    organization_id is not null
    and private.has_org_role(organization_id, array['admin']::org_role[])
  );
