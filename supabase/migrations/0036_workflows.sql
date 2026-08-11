-- 0036 工作流与运行记录
--
-- 工作流状态机与设计系统 WorkflowStatusBadge 的 10 个状态一一对应:
-- DRAFT / READY / QUEUED / RUNNING / WAITING_FOR_INPUT /
-- WAITING_FOR_APPROVAL / PAUSED / COMPLETED / FAILED / CANCELLED
-- 契约测试 tests/app/workflow-contract.test.ts 会核对这一致性。
--
-- v1 执行模型(如实说明):
--   定义生命周期走全 10 态;同步执行只产生 QUEUED/RUNNING/COMPLETED/FAILED,
--   WAITING_FOR_INPUT / WAITING_FOR_APPROVAL 保留在状态机里,
--   由后续「后台 Worker + 人工闸门」版本使用 —— 状态机先于执行器就位。

create table if not exists public.workflows (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 100),
  goal            text not null default '' check (char_length(goal) <= 500),
  definition      jsonb not null default '{"steps": []}'::jsonb,
  status          text not null default 'DRAFT' check (
    status in (
      'DRAFT','READY','QUEUED','RUNNING','WAITING_FOR_INPUT',
      'WAITING_FOR_APPROVAL','PAUSED','COMPLETED','FAILED','CANCELLED'
    )
  ),
  created_by      uuid not null references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.workflow_runs (
  id              uuid primary key default gen_random_uuid(),
  workflow_id     uuid not null references public.workflows(id) on delete cascade,
  status          text not null default 'QUEUED' check (
    status in (
      'DRAFT','READY','QUEUED','RUNNING','WAITING_FOR_INPUT',
      'WAITING_FOR_APPROVAL','PAUSED','COMPLETED','FAILED','CANCELLED'
    )
  ),
  trigger_source  text not null default 'manual',
  output          jsonb,
  error           text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists workflows_org_idx on public.workflows (organization_id);
create index if not exists workflow_runs_workflow_idx on public.workflow_runs (workflow_id, created_at desc);

-- RLS:成员可读;创建者本人可改/删;写操作以 auth.uid() 落 created_by。
alter table public.workflows enable row level security;
alter table public.workflow_runs enable row level security;

create policy workflows_select_member on public.workflows
  for select to authenticated
  using (private.is_org_member(organization_id));

create policy workflows_insert_member on public.workflows
  for insert to authenticated
  with check (
    private.is_org_member(organization_id)
    and created_by = (select auth.uid())
  );

create policy workflows_update_own on public.workflows
  for update to authenticated
  using (created_by = (select auth.uid()))
  with check (
    created_by = (select auth.uid())
    and private.is_org_member(organization_id)
  );

create policy workflows_delete_own on public.workflows
  for delete to authenticated
  using (created_by = (select auth.uid()));

create policy workflow_runs_select_member on public.workflow_runs
  for select to authenticated
  using (
    exists (
      select 1 from public.workflows w
      where w.id = workflow_runs.workflow_id
        and private.is_org_member(w.organization_id)
    )
  );

create policy workflow_runs_insert_member on public.workflow_runs
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workflows w
      where w.id = workflow_runs.workflow_id
        and private.is_org_member(w.organization_id)
    )
  );

create policy workflow_runs_update_member on public.workflow_runs
  for update to authenticated
  using (
    exists (
      select 1 from public.workflows w
      where w.id = workflow_runs.workflow_id
        and private.is_org_member(w.organization_id)
    )
  );
