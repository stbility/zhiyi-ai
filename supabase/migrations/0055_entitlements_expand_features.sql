-- 0055_entitlements_expand_features.sql
-- 权益矩阵扩展:补齐营销页承诺的 feature(2026-08-11)。
--
-- 【背景】plans.ts 营销页承诺了并发任务数、执行历史天数、知识库容量、
-- 外部 MCP 数量,但 entitlements 表只有 workflows + monthly_agent_turns
-- 两项 —— 承诺没有 gating,免费用户也能用付费承诺的功能,权益不一致。
--
-- 【新增 feature 语义】
--   concurrent_tasks   同时运行的智能体/工作流任务数(quota=个数)
--   history_days       执行历史保留天数(quota=天数;null=永久)
--   knowledge_capacity 知识库容量 MB(quota=MB;null=不限)
--   mcp_servers        可登记的 MCP server 数(quota=个数)
--
-- 【数值对齐 plans.ts 承诺】
--   free:              1 并发 / 无历史天数 / 知识库基础 / 1 个 MCP
--   professional:      2 并发 / 90 天 / 个人知识库 / 2 个 MCP
--   professional_plus: 5 并发 / 365 天 / 更大容量 / 5 个 MCP
--   team:              不限并发 / 完整审计(历史不限) / 组织知识库 / 10 个 MCP
--   enterprise:        全部不限
--
-- 迁移必须是纯 SQL(plpgsql assert 会红 CI)。幂等:on conflict do update。

insert into public.entitlements (plan_id, feature, quota) values
  ('free',              'concurrent_tasks',   1),
  ('professional',      'concurrent_tasks',   2),
  ('professional_plus', 'concurrent_tasks',   5),
  ('team',              'concurrent_tasks',   null),
  ('enterprise',        'concurrent_tasks',   null),

  ('free',              'history_days',       null),
  ('professional',      'history_days',       90),
  ('professional_plus', 'history_days',       365),
  ('team',              'history_days',       null),
  ('enterprise',        'history_days',       null),

  ('free',              'knowledge_capacity', 100),
  ('professional',      'knowledge_capacity', 1000),
  ('professional_plus', 'knowledge_capacity', 5000),
  ('team',              'knowledge_capacity', null),
  ('enterprise',        'knowledge_capacity', null),

  ('free',              'mcp_servers',        1),
  ('professional',      'mcp_servers',        2),
  ('professional_plus', 'mcp_servers',        5),
  ('team',              'mcp_servers',        10),
  ('enterprise',        'mcp_servers',        null)
on conflict (plan_id, feature) do update set quota = excluded.quota;
