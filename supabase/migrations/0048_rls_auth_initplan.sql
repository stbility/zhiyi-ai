-- 0048_rls_auth_initplan.sql
-- Performance Advisor「Auth RLS 初始化计划」修复(2026-08-10):
--   策略表达式里直接调 auth.uid() → PostgreSQL 对**每一行**求值一次;
--   包成 (select auth.uid()) 变成 InitPlan,整条查询只算一次 —— 官方推荐写法。
--
-- ⚠️ 生产漂移(2026-08-10 实证):0012 已 drop 掉 profiles_select_self /
--   profiles_select_org_peers / organizations_select_creator /
--   memberships_insert_creator_bootstrap 并合并为 profiles_select_visible 等,
--   但**生产库仍存在这些旧策略**(Advisor 在 production 实测看到并报错)。
--   因此本迁移用 DO 块 + pg_policies 存在性检查,只在策略存在时改写:
--   · 全新重放库(0012 已删)→ 跳过,无副作用
--   · 生产库(旧策略仍在)→ 改写,清 Advisor
--   两种状态都安全、幂等。
--
-- 只改表达式,不改策略名/角色/行为语义 —— 等价变换,契约快照(策略名)不变。

-- profiles
do $$ begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_select_self') then
    execute 'alter policy profiles_select_self on public.profiles using (id = (select auth.uid()))';
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_select_org_peers') then
    execute 'alter policy profiles_select_org_peers on public.profiles using (
      exists (
        select 1
        from public.memberships mine
        join public.memberships theirs
          on theirs.organization_id = mine.organization_id
        where mine.user_id = (select auth.uid())
          and mine.status = ''active''
          and theirs.status = ''active''
          and theirs.user_id = public.profiles.id
      )
    )';
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_insert_self') then
    execute 'alter policy profiles_insert_self on public.profiles with check (id = (select auth.uid()))';
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_update_self') then
    execute 'alter policy profiles_update_self on public.profiles using (id = (select auth.uid())) with check (id = (select auth.uid()))';
  end if;
end $$;

-- organizations
do $$ begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='organizations' and policyname='organizations_insert_self') then
    execute 'alter policy organizations_insert_self on public.organizations with check (created_by = (select auth.uid()))';
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='organizations' and policyname='organizations_select_creator') then
    execute 'alter policy organizations_select_creator on public.organizations using (created_by = (select auth.uid()))';
  end if;
end $$;

-- memberships
do $$ begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='memberships' and policyname='memberships_insert_creator_bootstrap') then
    execute 'alter policy memberships_insert_creator_bootstrap on public.memberships with check (
      user_id = (select auth.uid())
      and role = ''owner''
      and exists (
        select 1
        from public.organizations o
        where o.id = memberships.organization_id
          and o.created_by = (select auth.uid())
      )
    )';
  end if;
end $$;

-- conversations(生产当前为 0008 的 private.is_org_member 版本;重放库同)
do $$ begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='conversations' and policyname='conversations_own') then
    execute 'alter policy conversations_own on public.conversations using (user_id = (select auth.uid()) and private.is_org_member(organization_id)) with check (user_id = (select auth.uid()) and private.is_org_member(organization_id))';
  end if;
end $$;

-- messages
do $$ begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='messages' and policyname='messages_own') then
    execute 'alter policy messages_own on public.messages using (
      exists (select 1 from public.conversations c
              where c.id = messages.conversation_id and c.user_id = (select auth.uid()))
    ) with check (
      exists (select 1 from public.conversations c
              where c.id = messages.conversation_id and c.user_id = (select auth.uid()))
    )';
  end if;
end $$;
