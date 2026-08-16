-- 0065_agent_runs_fallback_audit.sql
-- P1 Runtime Fallback:可审计的 fallback 追踪(最小字段,向后兼容)。
--
-- 语义(见 P1 D1 字段语义表):
--   agent_runs.provider_id / model_id   = 最终执行(executed)。既有语义兼容:
--     单次尝试时"运行服务商/模型"与"最终执行"相同,既有 34 行含义不变。
--   requested_provider_id / requested_model_id = 用户原始选择(Primary)。
--     仅审计用途,无业务读取方;fallback 时二者与 provider_id/model_id 不同。
--   attempt_count      = 本次运行实际尝试次数(1 = 无 fallback)。
--   fallback_used      = 是否发生过 Provider/Model 切换。
--
-- 不动 0064(agent_runs.task_type)、不改任何既有 NOT NULL / DEFAULT / CHECK。

alter table public.agent_runs
  add column if not exists requested_provider_id uuid
    references public.ai_providers(id) on delete set null,
  add column if not exists requested_model_id text,
  add column if not exists attempt_count integer not null default 1
    check (attempt_count >= 1),
  add column if not exists fallback_used boolean not null default false;

-- Fallback 事件表:每次 attempt 一条,可完整还原执行轨迹
-- (attempt 1/2/3 … 顺序 = started_at 升序;status 记该次尝试结果)。
create table if not exists public.agent_run_fallback_events (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.agent_runs(id) on delete cascade,
  attempt_number integer not null check (attempt_number >= 1),
  provider_id    uuid references public.ai_providers(id) on delete set null,
  model_id       text not null,
  status         text not null
    check (status in ('running', 'success', 'failed', 'skipped')),
  failure_class  text,
  reason         text,
  started_at     timestamptz not null default now(),
  completed_at   timestamptz
);

create index if not exists agent_run_fallback_events_run_idx
  on public.agent_run_fallback_events (run_id, attempt_number);

-- RLS:与 agent_runs/agent_steps 同一套模型(0027)——
-- 归属跟着对话走,读写都只有对话的主人。service_role 经
-- agent_runs 的 service 路径写入(运行期服务端)。
alter table public.agent_run_fallback_events enable row level security;

create policy agent_run_fallback_events_own on public.agent_run_fallback_events
  for all to authenticated
  using (
    exists (
      select 1 from public.agent_runs ar
      join public.conversations c on c.id = ar.conversation_id
      where ar.id = agent_run_fallback_events.run_id
        and c.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.agent_runs ar
      join public.conversations c on c.id = ar.conversation_id
      where ar.id = agent_run_fallback_events.run_id
        and c.user_id = (select auth.uid())
    )
  );
