-- =============================================================================
-- Phase 1 · 身份、组织与权限
--
-- 纯新增迁移:只含 CREATE / ALTER ADD,不含任何 DROP 或改写既有数据的语句。
--
-- 设计要点:
--   1. 每张业务表都启用 RLS,且默认拒绝。没有匹配策略 = 无法访问,
--      而不是「忘了写策略就全放开」。
--   2. 组织内的可见性由 memberships 决定,统一走 SECURITY DEFINER 函数判定,
--      避免策略之间互相递归查询导致的无限递归错误。
--   3. 角色权限用枚举而非自由文本,防止拼写错误静默降级为「无权限」或「超级权限」。
-- =============================================================================

-- 生成 UUID 用
create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- 枚举
-- -----------------------------------------------------------------------------
do $$ begin
  create type public.org_role as enum ('owner', 'admin', 'member', 'viewer');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.membership_status as enum ('active', 'invited', 'suspended');
exception when duplicate_object then null;
end $$;

-- -----------------------------------------------------------------------------
-- profiles —— 与 auth.users 一一对应的公开资料
--
-- auth.users 由 Supabase 管理,不直接暴露给客户端。业务侧需要的用户信息放这里。
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text,
  avatar_url    text,
  locale        text not null default 'zh-CN',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- -----------------------------------------------------------------------------
-- organizations
-- -----------------------------------------------------------------------------
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 100),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  created_by  uuid not null references auth.users (id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.organizations enable row level security;

-- -----------------------------------------------------------------------------
-- memberships —— 用户与组织的关系,承载角色
-- -----------------------------------------------------------------------------
create table if not exists public.memberships (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  role             public.org_role not null default 'member',
  status           public.membership_status not null default 'active',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, user_id)
);

alter table public.memberships enable row level security;

create index if not exists memberships_user_idx on public.memberships (user_id);
create index if not exists memberships_org_idx  on public.memberships (organization_id);

-- -----------------------------------------------------------------------------
-- audit_logs —— 审计日志
--
-- 只允许追加。任何角色都不得 UPDATE 或 DELETE —— 可篡改的审计日志没有意义。
-- 不写 update/delete 策略即为禁止(RLS 默认拒绝)。
-- -----------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id               bigint generated always as identity primary key,
  organization_id  uuid references public.organizations (id) on delete cascade,
  actor_id         uuid references auth.users (id) on delete set null,
  action           text not null,
  resource_type    text not null,
  resource_id      text,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

alter table public.audit_logs enable row level security;

create index if not exists audit_logs_org_created_idx
  on public.audit_logs (organization_id, created_at desc);

-- =============================================================================
-- 权限判定函数
--
-- 用 SECURITY DEFINER 绕过 RLS 读 memberships。原因:若在 memberships 的策略里
-- 再查 memberships,Postgres 会陷入策略递归并报错。这是该场景的标准解法。
--
-- search_path 固定为 public,防止调用方通过修改 search_path 劫持函数解析。
-- =============================================================================
create or replace function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = org
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create or replace function public.has_org_role(org uuid, roles public.org_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = org
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role = any(roles)
  );
$$;

revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.has_org_role(uuid, public.org_role[]) from public;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.has_org_role(uuid, public.org_role[]) to authenticated;

-- =============================================================================
-- RLS 策略
-- =============================================================================

-- profiles:本人可读写自己的资料;同组织成员可读对方资料(需要显示协作者姓名)
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists profiles_select_org_peers on public.profiles;
create policy profiles_select_org_peers on public.profiles
  for select to authenticated
  using (
    exists (
      select 1
      from public.memberships mine
      join public.memberships theirs
        on theirs.organization_id = mine.organization_id
      where mine.user_id = auth.uid()
        and mine.status = 'active'
        and theirs.status = 'active'
        and theirs.user_id = public.profiles.id
    )
  );

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert to authenticated
  with check (id = auth.uid());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- organizations:仅成员可见;仅 owner/admin 可改;创建者必须是本人
drop policy if exists organizations_select_member on public.organizations;
create policy organizations_select_member on public.organizations
  for select to authenticated
  using (public.is_org_member(id));

drop policy if exists organizations_insert_self on public.organizations;
create policy organizations_insert_self on public.organizations
  for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists organizations_update_admin on public.organizations;
create policy organizations_update_admin on public.organizations
  for update to authenticated
  using (public.has_org_role(id, array['owner', 'admin']::public.org_role[]))
  with check (public.has_org_role(id, array['owner', 'admin']::public.org_role[]));

-- 【MED-3 修复】created_by 是 bootstrap 提权链的锚点
-- (organizations_select_visible / bootstrap 都依赖 created_by = auth.uid())。
-- 允许 admin 改写 created_by = 允许把任意用户变成该组织创建者,进而自封 owner。
-- 用列级 REVOKE(与 0018/0022/0030 密文列同款模式):created_by 对
-- authenticated 彻底只读 —— UPDATE 无法改它,INSERT 仍可写(创建时赋值)。
revoke update (created_by) on public.organizations from authenticated, anon;
grant update (id, name, slug, created_at, updated_at) on public.organizations to authenticated;

drop policy if exists organizations_delete_owner on public.organizations;
create policy organizations_delete_owner on public.organizations
  for delete to authenticated
  using (public.has_org_role(id, array['owner']::public.org_role[]));

-- memberships:成员可见同组织成员名单;仅 owner/admin 可增删改
drop policy if exists memberships_select_member on public.memberships;
create policy memberships_select_member on public.memberships
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists memberships_insert_admin on public.memberships;
create policy memberships_insert_admin on public.memberships
  for insert to authenticated
  with check (
    public.has_org_role(organization_id, array['owner', 'admin']::public.org_role[])
  );

drop policy if exists memberships_update_admin on public.memberships;
create policy memberships_update_admin on public.memberships
  for update to authenticated
  using (
    public.has_org_role(organization_id, array['owner', 'admin']::public.org_role[])
  )
  with check (
    public.has_org_role(organization_id, array['owner', 'admin']::public.org_role[])
    -- 【HIGH-2 修复】角色上限:admin 不能把角色改成 owner(或更高),
    -- 也不能给他人授予超过自己权限的角色 —— 否则 admin 可自封 owner 提权。
    -- owner 可授任意角色;非 owner(admin)目标角色只能是 member/admin。
    and (
      public.has_org_role(organization_id, array['owner']::public.org_role[])
      or public.memberships.role <> 'owner'::public.org_role
    )
  );

drop policy if exists memberships_delete_admin on public.memberships;
create policy memberships_delete_admin on public.memberships
  for delete to authenticated
  using (
    public.has_org_role(organization_id, array['owner', 'admin']::public.org_role[])
  );

-- audit_logs:成员可读本组织日志;任何人不可改不可删(不写对应策略即禁止)
drop policy if exists audit_logs_select_member on public.audit_logs;
create policy audit_logs_select_member on public.audit_logs
  for select to authenticated
  using (organization_id is not null and public.is_org_member(organization_id));

-- =============================================================================
-- 触发器
-- =============================================================================

-- updated_at 自动维护
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists organizations_touch on public.organizations;
create trigger organizations_touch before update on public.organizations
  for each row execute function public.touch_updated_at();

drop trigger if exists memberships_touch on public.memberships;
create trigger memberships_touch before update on public.memberships
  for each row execute function public.touch_updated_at();

-- 注册后自动建 profile。
-- 放在触发器里而不是应用层,是为了保证任何注册路径(邮箱、OAuth、后台创建)
-- 都必然有 profile,不依赖某一条代码路径记得调用。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
