-- 0011 RLS InitPlan 优化与缺失的外键索引
--
-- Supabase 的性能顾问报了 21 条告警,两类:
--
-- 1. auth.uid() 直接写在策略里,PostgreSQL 会对**每一行**求值一次。
--    包一层 (select auth.uid()) 之后它变成 InitPlan,整条查询只算一次。
--    行数越多差距越大,这是官方推荐的写法。
--
-- 2. 外键列没有索引 —— 删除父行时要全表扫子表。
--
-- 这份文件是从生产库反向导出补写的。它此前只有注释,正文写着
-- 「完整语句见 Supabase 迁移记录」,等于把真值源放在了云端。
-- 具体每张表的策略重建语句在各自的迁移里(0004/0006 等),
-- 这里只补当时新增的索引,避免与后续迁移互相覆盖。

create index if not exists messages_organization_idx
  on public.messages (organization_id);
create index if not exists conversations_organization_idx
  on public.conversations (organization_id);
create index if not exists ai_providers_created_by_idx
  on public.ai_providers (created_by);
create index if not exists organizations_created_by_idx
  on public.organizations (created_by);
create index if not exists audit_logs_actor_idx
  on public.audit_logs (actor_id);
