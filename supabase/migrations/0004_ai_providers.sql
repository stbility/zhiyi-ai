-- =============================================================================
-- Phase 3 · AI Provider 与模型注册表
--
-- 密钥以密文形态存储(AES-256-GCM,见 src/lib/crypto/secret-box.ts)。
-- 表中没有任何一列存放明文密钥 —— 即使数据库被拖走也拿不到可用凭据,
-- 前提是 ENCRYPTION_KEY 不与数据库存放在一起。
--
-- 与 organizations 不同,这里的 SELECT 策略不会造成引导死锁:
-- 创建 Provider 时成员关系已经存在,INSERT ... RETURNING 能通过 SELECT 策略。
-- =============================================================================

do $$ begin
  create type public.provider_kind as enum (
    'openai', 'anthropic', 'google', 'openai_compatible'
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.ai_providers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  kind             public.provider_kind not null,
  display_name     text not null check (length(btrim(display_name)) between 1 and 60),
  base_url         text check (base_url is null or base_url ~ '^https?://'),
  api_key_cipher   text not null,
  api_key_masked   text not null,
  enabled          boolean not null default true,
  last_tested_at   timestamptz,
  last_test_ok     boolean,
  last_test_error  text,
  created_by       uuid not null references auth.users (id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, display_name)
);
alter table public.ai_providers enable row level security;
create index if not exists ai_providers_org_idx on public.ai_providers (organization_id);

create table if not exists public.ai_models (
  id               uuid primary key default gen_random_uuid(),
  provider_id      uuid not null references public.ai_providers (id) on delete cascade,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  model_id         text not null check (length(btrim(model_id)) between 1 and 120),
  display_name     text not null check (length(btrim(display_name)) between 1 and 60),
  context_window   integer check (context_window is null or context_window > 0),
  max_output       integer check (max_output is null or max_output > 0),
  supports_streaming         boolean not null default true,
  supports_tools             boolean not null default false,
  supports_structured_output boolean not null default false,
  supports_vision            boolean not null default false,
  supports_embedding         boolean not null default false,
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (provider_id, model_id)
);
alter table public.ai_models enable row level security;
create index if not exists ai_models_provider_idx on public.ai_models (provider_id);
create index if not exists ai_models_org_idx      on public.ai_models (organization_id);

drop policy if exists ai_providers_select_member on public.ai_providers;
create policy ai_providers_select_member on public.ai_providers
  for select to authenticated using (public.is_org_member(organization_id));

drop policy if exists ai_providers_write_admin on public.ai_providers;
create policy ai_providers_write_admin on public.ai_providers
  for all to authenticated
  using (public.has_org_role(organization_id, array['owner','admin']::public.org_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin']::public.org_role[]));

drop policy if exists ai_models_select_member on public.ai_models;
create policy ai_models_select_member on public.ai_models
  for select to authenticated using (public.is_org_member(organization_id));

drop policy if exists ai_models_write_admin on public.ai_models;
create policy ai_models_write_admin on public.ai_models
  for all to authenticated
  using (public.has_org_role(organization_id, array['owner','admin']::public.org_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin']::public.org_role[]));

drop trigger if exists ai_providers_touch on public.ai_providers;
create trigger ai_providers_touch before update on public.ai_providers
  for each row execute function public.touch_updated_at();

drop trigger if exists ai_models_touch on public.ai_models;
create trigger ai_models_touch before update on public.ai_models
  for each row execute function public.touch_updated_at();
