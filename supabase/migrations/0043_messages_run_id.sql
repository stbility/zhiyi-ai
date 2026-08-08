-- 0043 消息 ↔ 运行记录关联(messages.run_id)
--
-- 背景:智能体撞上 300 秒平台上限时优雅暂停(interrupted + resumable),
-- 前端靠内存里的 resumeRef 续跑 —— 页面一刷新这个引用就没了,
-- 「继续运行」按钮消失,用户只能手打「继续」→ 无 resumeRunId →
-- 服务端从头搜索,已完成的步骤全部白做。
--
-- 本迁移给 messages 加 run_id(运行记录的外键):
--   1. agent-turn 写消息时带上 run_id(journal.runId)
--   2. 页面恢复会话时按 run_id 反查 agent_runs.status/resumable,
--      刷新后「继续运行」按钮依然在,续跑真正跨刷新可用
-- 历史消息 run_id 为 NULL,不影响(旧的断流运行本就没法从库恢复)。

alter table public.messages
  add column if not exists run_id uuid references public.agent_runs(id) on delete set null;

create index if not exists messages_run_id_idx
  on public.messages (run_id);
