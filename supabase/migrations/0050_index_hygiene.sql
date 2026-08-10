-- 0050_index_hygiene.sql
-- Performance Advisor 信息建议(2026-08-10,前 10 条)修复。
--
-- 一、6 条「未索引的外键」—— 真缺,补索引:
--   逐列核对过表定义(PK/UNIQUE/组合索引均未覆盖;与 0049 翻车不同,
--   0049 的两列是 PK 隐含索引,这里 6 列全部无覆盖):
--   · eval_cases.feedback_id(反馈飞轮同步幂等查 eval_cases where feedback_id)
--   · knowledge_files.created_by
--   · mcp_execution_log.token_id / user_id(org_created_idx 只覆盖 org)
--   · memories.message_id
--   · workflows.created_by
--   命名沿用仓库惯例(列名去 _id 后缀):<table>_<col>_idx。
--
-- 二、4 条「未使用索引」—— 防御性预建、应用层零查询路径,删:
--   · conversation_attachments_organization_idx(RLS 与查询全走
--     conversation_id,org 索引无消费方;0015 预建)
--   · ai_providers_created_by_idx / organizations_created_by_idx /
--     audit_logs_actor_idx(0011 预建;ai_providers/organizations 是小表
--     恒 seq scan,audit_logs 无 actor 过滤查询)
--   均非唯一约束(唯一索引删除会破坏约束,已逐条核对)。

-- 一、补外键索引
create index if not exists eval_cases_feedback_idx
  on public.eval_cases (feedback_id);
create index if not exists knowledge_files_created_by_idx
  on public.knowledge_files (created_by);
create index if not exists mcp_execution_log_token_idx
  on public.mcp_execution_log (token_id);
create index if not exists mcp_execution_log_user_idx
  on public.mcp_execution_log (user_id);
create index if not exists memories_message_idx
  on public.memories (message_id);
create index if not exists workflows_created_by_idx
  on public.workflows (created_by);

-- 二、删未使用索引
drop index if exists conversation_attachments_organization_idx;
drop index if exists ai_providers_created_by_idx;
drop index if exists audit_logs_actor_idx;
drop index if exists organizations_created_by_idx;

-- 核对(生产应用后):
--   select indexname from pg_indexes where schemaname='public'
--     and indexname in ('eval_cases_feedback_idx',
--       'knowledge_files_created_by_idx','mcp_execution_log_token_idx',
--       'mcp_execution_log_user_idx','memories_message_idx',
--       'workflows_created_by_idx');
--   6 行 = 全建;上面 4 个旧索引名应查不到。
