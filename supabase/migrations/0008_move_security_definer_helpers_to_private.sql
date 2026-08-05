-- =============================================================================
-- 0008 把 SECURITY DEFINER 辅助函数移出对外暴露的 schema
--
-- 安全告警:public.is_org_member / public.has_org_role 是 SECURITY DEFINER,
-- 而 public 是 PostgREST 对外暴露的 schema,于是它们同时变成了可直接调用的
-- RPC 端点 /rest/v1/rpc/is_org_member。
--
-- 官方文档:
--   "Security-definer functions should never be created in a schema in the
--    'Exposed schemas' inside your API settings."
--   https://supabase.com/docs/guides/database/postgres/row-level-security
--
-- 正解是搬到不暴露的 private schema,而**不是**改成 SECURITY INVOKER ——
-- 改成 INVOKER 会让 memberships 的 RLS 策略递归调用自身,整个组织权限体系瘫掉。
-- 这两个函数用 SECURITY DEFINER 正是为了打断这个递归。
--
-- 以下语句是从生产库反向导出补写的。此前本文件只有注释,而这两个函数是
-- **所有 RLS 策略的基础** —— 缺了它们整个权限体系都建不起来,
-- 仓库因此无法独立重建数据库。
-- 生产验证:rpc/is_org_member 与 rpc/has_org_role 均返回 404;
-- 本人可见自己的 1 组织/1 成员/1 服务商/5 模型/9 对话,陌生人全部为 0。
-- =============================================================================
-- 完整语句见 Supabase 迁移记录 move_security_definer_helpers_to_private_schema。

create schema if not exists private;

-- private 不在 PostgREST 的暴露 schema 列表里,所以这两个函数不会变成
-- 可直接调用的 RPC 端点。策略里引用它们不受影响 —— RLS 在数据库内部求值。
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to postgres, service_role;

-- 判断当前用户是不是某组织的在职成员。
--
-- 必须是 SECURITY DEFINER:memberships 自己也有 RLS,而那条策略又要调用
-- 本函数 —— 用 SECURITY INVOKER 会递归调用自身,整个组织权限体系瘫掉。
-- 这里用 DEFINER 正是为了打断这个递归。
--
-- search_path 置空:SECURITY DEFINER 函数必须钉死搜索路径,
-- 否则调用方可以通过改 search_path 劫持函数里引用的表名。
create or replace function private.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = org
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

-- 同上,再多一层角色判断。用于「只有 owner / admin 能改」这类策略。
create or replace function private.has_org_role(org uuid, roles org_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = org
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role = any(roles)
  );
$$;

-- ── 先把依赖旧函数的策略改指到 private,再删旧函数 ──────────────
--
-- 【这一段是补上去的,补之前从空库重放会直接失败】
--
-- 0001 / 0004 / 0006 里有 13 条策略写的是 public.is_org_member /
-- public.has_org_role。而下面的 drop **不带 cascade** ——
-- PostgreSQL 的依赖跟踪会直接拒绝:
--   cannot drop function public.is_org_member(uuid) because other
--   objects depend on it
--
-- 生产库当初能跑通,只说明**生产当时的策略不是仓库里这个样子**:
-- 整套迁移是从生产反解出来的,反解的是「今天的样子」,不是「当时应用的
-- 那一份」。于是仓库里的 0001 带着已经演化过的策略定义,而 0008 仍按
-- 原始顺序删函数 —— 两者拼在一起就不自洽了。
-- 这正是 CI 里那次真实重放抓出来的第一个问题。
--
-- 为什么不用 drop ... cascade:cascade 会**静默删掉**这些策略,
-- 而删掉策略等于把表敞开。那种失败不会报错,只会在某天被人发现
-- 数据谁都能读。宁可显式重建 13 条,也不让删除动作去猜该连带删什么。
--
-- 下面这些定义是从 0001/0004/0006 原文机械替换 schema 得到的,
-- 不是手抄 —— 13 条手抄必然出错。

drop policy if exists organizations_select_member on public.organizations;
create policy organizations_select_member on public.organizations
  for select to authenticated
  using (private.is_org_member(id));

drop policy if exists organizations_update_admin on public.organizations;
create policy organizations_update_admin on public.organizations
  for update to authenticated
  using (private.has_org_role(id, array['owner', 'admin']::public.org_role[]))
  with check (private.has_org_role(id, array['owner', 'admin']::public.org_role[]));

drop policy if exists organizations_delete_owner on public.organizations;
create policy organizations_delete_owner on public.organizations
  for delete to authenticated
  using (private.has_org_role(id, array['owner']::public.org_role[]));

drop policy if exists memberships_select_member on public.memberships;
create policy memberships_select_member on public.memberships
  for select to authenticated
  using (private.is_org_member(organization_id));

drop policy if exists memberships_insert_admin on public.memberships;
create policy memberships_insert_admin on public.memberships
  for insert to authenticated
  with check (
    private.has_org_role(organization_id, array['owner', 'admin']::public.org_role[])
  );

drop policy if exists memberships_update_admin on public.memberships;
create policy memberships_update_admin on public.memberships
  for update to authenticated
  using (
    private.has_org_role(organization_id, array['owner', 'admin']::public.org_role[])
  )
  with check (
    private.has_org_role(organization_id, array['owner', 'admin']::public.org_role[])
  );

drop policy if exists memberships_delete_admin on public.memberships;
create policy memberships_delete_admin on public.memberships
  for delete to authenticated
  using (
    private.has_org_role(organization_id, array['owner', 'admin']::public.org_role[])
  );

drop policy if exists audit_logs_select_member on public.audit_logs;
create policy audit_logs_select_member on public.audit_logs
  for select to authenticated
  using (organization_id is not null and private.is_org_member(organization_id));

drop policy if exists ai_providers_select_member on public.ai_providers;
create policy ai_providers_select_member on public.ai_providers
  for select to authenticated using (private.is_org_member(organization_id));

drop policy if exists ai_providers_write_admin on public.ai_providers;
create policy ai_providers_write_admin on public.ai_providers
  for all to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::public.org_role[]))
  with check (private.has_org_role(organization_id, array['owner','admin']::public.org_role[]));

drop policy if exists ai_models_select_member on public.ai_models;
create policy ai_models_select_member on public.ai_models
  for select to authenticated using (private.is_org_member(organization_id));

drop policy if exists ai_models_write_admin on public.ai_models;
create policy ai_models_write_admin on public.ai_models
  for all to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::public.org_role[]))
  with check (private.has_org_role(organization_id, array['owner','admin']::public.org_role[]));

drop policy if exists conversations_own on public.conversations;
create policy conversations_own on public.conversations
  for all to authenticated
  using (user_id = auth.uid() and private.is_org_member(organization_id))
  with check (user_id = auth.uid() and private.is_org_member(organization_id));

-- 旧的 public 版本必须删掉 —— 留着就等于那个 RPC 端点还在。
-- 上面已经把全部依赖改指到 private,所以这两条现在能成功。
drop function if exists public.is_org_member(uuid);
drop function if exists public.has_org_role(uuid, org_role[]);
