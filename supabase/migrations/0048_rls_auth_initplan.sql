-- 0048_rls_auth_initplan.sql
-- Performance Advisor「Auth RLS 初始化计划」修复(2026-08-10):
--   策略表达式里直接调 auth.uid() → PostgreSQL 对**每一行**求值一次;
--   包成 (select auth.uid()) 变成 InitPlan,整条查询只算一次 —— 官方推荐写法。
--
-- 背景:0011 当年只补了索引,策略重写留成注释没做;0012 之后的新策略
-- 全部已用 (select auth.uid()) 写法,早期 0001/0003/0006/0008 的 10 条
-- 一直裸调用 —— 正是 Performance Advisor 前 7 条(profiles×4 / organizations×2 /
-- memberships×1)与其余条目的来源。
--
-- 只改表达式,不改策略名/角色/行为语义 —— 等价变换,契约快照(策略名)不变。

-- profiles
alter policy profiles_select_self on public.profiles
  using (id = (select auth.uid()));

alter policy profiles_select_org_peers on public.profiles
  using (
    exists (
      select 1
      from public.memberships mine
      join public.memberships theirs
        on theirs.organization_id = mine.organization_id
      where mine.user_id = (select auth.uid())
        and mine.status = 'active'
        and theirs.status = 'active'
        and theirs.user_id = public.profiles.id
    )
  );

alter policy profiles_insert_self on public.profiles
  with check (id = (select auth.uid()));

alter policy profiles_update_self on public.profiles
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- organizations
alter policy organizations_insert_self on public.organizations
  with check (created_by = (select auth.uid()));

alter policy organizations_select_creator on public.organizations
  using (created_by = (select auth.uid()));

-- memberships
alter policy memberships_insert_creator_bootstrap on public.memberships
  with check (
    user_id = (select auth.uid())
    and role = 'owner'
    and exists (
      select 1
      from public.organizations o
      where o.id = memberships.organization_id
        and o.created_by = (select auth.uid())
    )
  );

-- conversations(生产当前为 0008 的 private.is_org_member 版本)
alter policy conversations_own on public.conversations
  using (user_id = (select auth.uid()) and private.is_org_member(organization_id))
  with check (user_id = (select auth.uid()) and private.is_org_member(organization_id));

-- messages
alter policy messages_own on public.messages
  using (
    exists (select 1 from public.conversations c
            where c.id = messages.conversation_id and c.user_id = (select auth.uid()))
  )
  with check (
    exists (select 1 from public.conversations c
            where c.id = messages.conversation_id and c.user_id = (select auth.uid()))
  );
