-- 0032 告警处置:补 FK 维护索引 + rate_limits 设计说明
--
-- Supabase 安全助手 2026-08-07 报了 20 条告警,逐条核对后:
--
-- ① rate_limits 无 RLS 策略 —— 刻意设计(见 0013 注释):这张表只有
--    service_role 会碰,RLS 全拒绝正是想要的效果。本迁移补一句
--    comment on table,让下轮扫描不再困惑。
--
-- ② agent_runs_provider_id_fkey 无覆盖索引 —— 真实缺口。
--    agent_runs.provider_id -> ai_providers(id) on delete set null。
--    删除一个服务商时,PG 要定位 agent_runs 里所有引用它的行置空;
--    没有索引 = 全表扫 agent_runs。与 0012 给 messages 补
--    messages_provider_idx 是同一个理由。
--
-- ③ 其余 7 条"未使用索引"告警 —— 经核实**全部保留**,原因:
--    Supabase 的"未使用"判定只看 idx_scan(查询是否走它),
--    不理解 FK 维护用途。这些索引服务于删除父行时的子表定位:
--      · messages_organization_idx / conversation_attachments_organization_idx
--        -> organizations on delete cascade。代码里有真实删除组织路径
--           (today/actions.ts、personal-org.ts),删组织必须扫子表找引用行。
--      · ai_providers/organizations created_by -> auth.users on delete restrict
--      · audit_logs actor_id、integrations/workspaces created_by
--        -> auth.users on delete set null
--    删掉它们,删用户/删组织就会退化成全表扫 —— 0012 已经为同样的
--    原因补过一次索引,这里不再犯第二次。
--
-- 【纯增量】create index + comment,不改任何表结构、策略、授权。

-- ① rate_limits 的设计意图落成注释,避免被误读为漏配
comment on table public.rate_limits is
  '对话/注册限流计数。刻意不建 RLS 策略:仅 service_role 经 bump_rate_limit RPC 访问,RLS 全拒绝即意图';

-- ② 补 agent_runs.provider_id 的 FK 维护索引
create index if not exists agent_runs_provider_idx
  on public.agent_runs (provider_id);
