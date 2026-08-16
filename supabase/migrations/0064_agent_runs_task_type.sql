-- 0064_agent_runs_task_type.sql
-- P0-2/P0-3:任务类型进入运行时可追踪上下文。
--
-- agent_runs.task_type 记录「这轮智能体运行是什么任务类型」:
--   text / coding / agent / vision / image / video
-- 缺省 'text' —— 既有行与旧请求(不传 taskType)保持兼容,不迁移、不破坏。
-- 该列只用于追踪与审计,不改变任何现有执行逻辑。

alter table public.agent_runs
  add column if not exists task_type text not null default 'text'
  check (task_type in ('text', 'coding', 'agent', 'vision', 'image', 'video'));
