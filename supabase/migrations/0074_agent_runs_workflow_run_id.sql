-- 0074_agent_runs_workflow_run_id.sql
-- Workflow ↔ Agent Run 持久 Lineage:让数据库能回答
-- 「这个 Agent Run 属于哪个 Workflow Run」。
--
-- 目标关系:
--   Workflow → workflow_runs → agent_runs.workflow_run_id → agent_steps.run_id
--
-- 【纯新增】单列可空,不改任何现有列/约束/语义;不新增反向列
-- (workflow_runs.agent_run_id),不做双向 Lineage。
-- 【删除语义】Workflow Run 被删除时该列置 NULL(SET NULL),不级联删除
-- 其下的 Agent Run / Agent Steps。
-- 【幂等】add column if not exists / create index if not exists,重放安全。

begin;

alter table public.agent_runs
  add column if not exists workflow_run_id uuid
    references public.workflow_runs(id) on delete set null;

create index if not exists agent_runs_workflow_run_idx
  on public.agent_runs (workflow_run_id);

commit;
