-- 0039 评测运行记录(eval_runs)
--
-- 评测集:20 条用例定义在代码里(src/lib/eval/cases.ts),随版本走 git ——
-- 「同一版本连跑两次通过率一致」的前提是用例与版本绑定,而不是在库里漂移。
-- 本迁移只存「运行结果」:一次跑评测 = 一行 eval_runs + 每用例一行 eval_run_cases。
--
-- 状态机:running → completed(全部跑完)/ partial(预算内只跑了一部分)。
-- 可复现性的诚实边界:检查器是确定性的(按 must_contain/must_not_contain
-- 判等),LLM 输出本身有概率性 —— 连跑对比如实展示,不粉饰。

create table if not exists public.eval_runs (
  id            uuid primary key default gen_random_uuid(),
  status        text not null default 'running' check (status in ('running','completed','partial')),
  version_sha   text not null,
  model         text not null default '',
  total_cases   integer not null default 0,
  passed        integer not null default 0,
  failed        integer not null default 0,
  skipped       integer not null default 0,
  pass_rate     numeric not null default 0,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  created_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now()
);

create table if not exists public.eval_run_cases (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.eval_runs(id) on delete cascade,
  case_key      text not null,
  case_name     text not null,
  status        text not null check (status in ('passed','failed','skipped','timeout')),
  output        text,
  error         text,
  duration_ms   integer not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists eval_runs_created_by_idx on public.eval_runs (created_by, created_at desc);
create index if not exists eval_run_cases_run_idx on public.eval_run_cases (run_id);

-- RLS:自己的运行自己看;用例定义在代码里,不在此表。
alter table public.eval_runs enable row level security;
alter table public.eval_run_cases enable row level security;

create policy eval_runs_select_own on public.eval_runs
  for select to authenticated
  using (created_by = (select auth.uid()));

create policy eval_runs_insert_own on public.eval_runs
  for insert to authenticated
  with check (created_by = (select auth.uid()));

create policy eval_runs_update_own on public.eval_runs
  for update to authenticated
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));

create policy eval_run_cases_select_own on public.eval_run_cases
  for select to authenticated
  using (
    exists (
      select 1 from public.eval_runs r
      where r.id = eval_run_cases.run_id
        and r.created_by = (select auth.uid())
    )
  );

create policy eval_run_cases_insert_own on public.eval_run_cases
  for insert to authenticated
  with check (
    exists (
      select 1 from public.eval_runs r
      where r.id = eval_run_cases.run_id
        and r.created_by = (select auth.uid())
    )
  );
