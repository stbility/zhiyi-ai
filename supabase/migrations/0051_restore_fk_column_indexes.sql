-- 0051_restore_fk_column_indexes.sql
-- 0050 误删的 4 条 FK 列索引恢复(2026-08-10 排查实锤)。
--
-- 教训:Performance Advisor 的两个检查在 FK 列上**互相冲突**——
--   0001「未索引外键」:FK 列必须建索引(join/cascade/RI 性能,官方标准实践)
--   0005「未使用索引」:idx_scan=0 的索引建议删除
-- 对「零查询流量的 FK 列」,0005 会报未使用;但删了索引,0001 立刻把它
-- 列为未索引外键(生产实测:ai_providers_created_by_fkey 在 0050 后出现)。
-- 结论:0001 是必须满足的硬规则(FK 完整性/级联/join 性能),0005 只应
-- 作用于**非 FK 列的索引**。0050 的 4 条删除全部落在 FK 列上 = 错误决策,
-- 本迁移恢复。恢复后 0005 若再次报这些索引「未使用」= 预期 INFO 噪声
-- (FK 防御性索引,不删);它们同时支撑 FK 级联删除的索引查找。

create index if not exists ai_providers_created_by_idx
  on public.ai_providers (created_by);
create index if not exists organizations_created_by_idx
  on public.organizations (created_by);
create index if not exists conversation_attachments_organization_idx
  on public.conversation_attachments (organization_id);
create index if not exists audit_logs_actor_idx
  on public.audit_logs (actor_id);

-- 核对(生产应用后 4 行):
--   select indexname from pg_indexes where schemaname='public'
--     and indexname in ('ai_providers_created_by_idx',
--       'organizations_created_by_idx',
--       'conversation_attachments_organization_idx',
--       'audit_logs_actor_idx');
