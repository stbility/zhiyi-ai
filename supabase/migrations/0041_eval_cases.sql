-- 0041 反馈飞轮消费端:eval_cases(从用户改写沉淀的评测用例)
--
-- 闭环:用户把 AI 回答改写成自己想要的(verdict='edited')→
-- 同步管道提取「改了什么」(原文没有的短语)→ 生成评测用例 →
-- runner 一键跑这些用例 → 通过率反映模型离用户想要的样子差多远。
--
-- 与内置 20 条(src/lib/eval/cases.ts)的区别:内置随版本走 git,
-- 这里是从真实反馈长出来的用例 —— 两条腿,一个 runner。

create table if not exists public.eval_cases (
  id                 uuid primary key default gen_random_uuid(),
  -- 幂等键:同一反馈只生成一次(fb_<feedback_id>)
  key                text not null unique,
  name               text not null,
  prompt             text not null,
  must_contain       text[] not null default '{}',
  must_contain_any   text[] not null default '{}',
  must_not_contain   text[] not null default '{}',
  timeout_ms         integer not null default 25000,
  source             text not null default 'feedback' check (source in ('seed','feedback')),
  feedback_id        uuid references public.message_feedback(id) on delete set null,
  enabled            boolean not null default true,
  created_by         uuid not null references auth.users(id),
  created_at         timestamptz not null default now()
);

create index if not exists eval_cases_created_by_idx on public.eval_cases (created_by, created_at desc);

alter table public.eval_cases enable row level security;

create policy eval_cases_select_own on public.eval_cases
  for select to authenticated
  using (created_by = (select auth.uid()));

create policy eval_cases_insert_own on public.eval_cases
  for insert to authenticated
  with check (created_by = (select auth.uid()));

create policy eval_cases_delete_own on public.eval_cases
  for delete to authenticated
  using (created_by = (select auth.uid()));
