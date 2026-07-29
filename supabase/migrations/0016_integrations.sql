-- =============================================================================
-- 0016 集成
--
-- 智能体要能「干活」,就得能调外部服务。这张表是所有外部能力的统一入口:
-- 搜索、代码仓库、以后的通知与业务系统,都走同一套凭据存储与连接验证。
--
-- 与 ai_providers 分开而非复用,因为语义不同:
--   ai_providers  用哪个模型说话
--   integrations  能调用哪些外部能力
-- 混在一起会把「模型服务」这个概念撑变形,后面每加一种集成都要改模型逻辑。
--
-- 凭据与模型密钥同一套处理:AES-256-GCM 加密落库,界面只显示掩码。
-- 写策略拆成 insert/update/delete 三条而非 for all —— 避免与 select
-- 重叠成多条宽松策略(性能 linter 会报)。
--
-- 本文件与已应用到生产的迁移一致,仅作仓库留档。
-- =============================================================================

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete cascade,
  kind text not null,
  display_name text not null,
  credential_cipher text not null,
  credential_masked text not null,
  enabled boolean not null default true,
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_error text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, kind)
);

create index if not exists integrations_organization_idx
  on public.integrations (organization_id);
create index if not exists integrations_created_by_idx
  on public.integrations (created_by);

alter table public.integrations enable row level security;

create policy integrations_select_member on public.integrations
  for select to authenticated
  using (private.is_org_member(organization_id));

create policy integrations_insert_admin on public.integrations
  for insert to authenticated
  with check (private.has_org_role(organization_id, array['owner'::public.org_role, 'admin'::public.org_role]));
create policy integrations_update_admin on public.integrations
  for update to authenticated
  using (private.has_org_role(organization_id, array['owner'::public.org_role, 'admin'::public.org_role]))
  with check (private.has_org_role(organization_id, array['owner'::public.org_role, 'admin'::public.org_role]));
create policy integrations_delete_admin on public.integrations
  for delete to authenticated
  using (private.has_org_role(organization_id, array['owner'::public.org_role, 'admin'::public.org_role]));
