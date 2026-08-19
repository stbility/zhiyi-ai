-- 0072 生产独有索引纳入仓库(2026-08-19)
--
-- 背景:只读审计发现两个索引仅存在于生产库,仓库迁移与契约快照
-- (expected-indexes.txt)均无对应 CREATE INDEX —— 疑似控制台直建,
-- 违反「先写迁移再应用」纪律。从零重建的库缺这两条 FK 列索引。
--
-- 本迁移把生产现有定义原样纳入仓库(幂等,生产已存在则 no-op):
--   ai_model_exclusions_model_id_idx  btree (model_id)        FK 列索引
--   sales_leads_created_by_idx        btree (created_by)      FK 列索引(0059 只建了 status_idx)
--
-- 定义与生产实测 indexdef 完全一致,不新增、不改变现有索引。

create index if not exists ai_model_exclusions_model_id_idx
  on public.ai_model_exclusions using btree (model_id);

create index if not exists sales_leads_created_by_idx
  on public.sales_leads using btree (created_by);
