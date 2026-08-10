-- 0049_missing_fk_indexes.sql
-- Performance Advisor 主动审计(2026-08-10,不等告警清单先修实锤):
--   usage_metering   —— 全表无任何索引;get_monthly_usage / bump_usage 按
--                       (user_id, category) 查 → 每次全表扫描
--   stripe_customers —— 全表无任何索引;checkout/webhook 按 user_id 反查
--                       customer_id → 全表扫描
-- 其余 FK 列已有覆盖(组合索引前导列含 org / user 等,可服务单列查询)。
create index if not exists usage_metering_user_category_idx
  on public.usage_metering (user_id, category);

create index if not exists stripe_customers_user_idx
  on public.stripe_customers (user_id);
