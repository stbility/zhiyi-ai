-- 0063 system_logs.actor_id 外键索引(Performance Advisor 0001 修复)
--
-- 【告警】Performance Advisor 0001 unindexed_foreign_keys:
--   Table `public.system_logs` has a foreign key `system_logs_actor_id_fkey`
--   without a covering index.
--
-- 【为什么漏了】0056 建 system_logs 时只建了 org_created / level_created
-- 两个查询索引,漏了 actor_id —— 它是 FK(auth.users),但当时没有按
-- actor 过滤的查询路径,也没人核对 FK 列索引清单。
--
-- 【修复】FK 列必须建索引(官方标准实践:join 性能 + 父表删除时子表
-- 级联查找 + RI 完整性)。与 0032/0050/0051 同一纪律:
-- 每张表的每个 FK 列都有覆盖索引。
--
-- 【纯新增】不改任何现有表、策略、授权、其他索引。

create index if not exists system_logs_actor_idx
  on public.system_logs (actor_id);

-- 核对(生产应用后应 1 行):
--   select indexname from pg_indexes where schemaname='public'
--     and indexname = 'system_logs_actor_idx';
