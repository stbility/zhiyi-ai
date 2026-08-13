-- 0060 修正历史权益倒挂(P0-5)
--
-- 【背景】0055 给 free 配了 history_days = null,而实现层(conversations.ts)
-- 把 null 解释为「不过滤 = 永久保留」——于是 Free 用户的历史可见范围
-- 反而大于 Professional(90 天),权益随档位不单调,降级后看到更多历史。
--
-- 【修正】free 改为 7 天(留出基本体验,不再无限);null 语义保留为
-- 「永久」,仅 team/enterprise 拥有。professional=90 / professional_plus=365 不变。
--
-- 【纯数据更新】不改表结构、策略、索引 —— 无需同步 expected-* 快照。

insert into public.entitlements (plan_id, feature, quota) values
  ('free', 'history_days', 7)
on conflict (plan_id, feature) do update set quota = excluded.quota;
