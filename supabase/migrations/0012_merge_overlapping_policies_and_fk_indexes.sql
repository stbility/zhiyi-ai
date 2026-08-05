-- 0012 合并重叠策略、拆分 FOR ALL 写策略、补外键索引
--
-- 【这个文件是补回来的,不是新写的】
--
-- 生产库的迁移账本里有 `merge_overlapping_policies_and_fk_indexes`
-- (version 20260729114349),而仓库里**没有对应文件** —— 编号从 0011
-- 直接跳到 0013。整套迁移当初是从生产反解出来的,这一条漏掉了。
--
-- 后果不是安全漏洞(合并前后有效权限相同),而是**灾难恢复出来的库
-- 与生产不是同一个东西**:
--   · 9 条策略名对不上
--   · messages 少一个外键索引
--   · Supabase 的检查器会报「同一动作有多条重叠的宽松策略」
--
-- 内容依据是**生产库当下的真实定义**(pg_policies / pg_indexes),
-- 不是凭记忆写的。核对方式见文件末尾。
--
-- 为什么这条一直没被发现:迁移测试只对文件内容做正则匹配,
-- 从没真的起一个 PostgreSQL 把 migrations/ 全量重放一遍。
-- 「文件里写没写这句话」和「跑完之后库长什么样」是两件事。

-- ── 一、合并重叠的 SELECT 策略 ──────────────────────────────
--
-- 同一个动作上有多条宽松(permissive)策略时,Postgres 要**逐条求值再 OR**。
-- 合并成一条不改变有效权限,但少一次策略求值 —— 在 RLS 密集的表上这是
-- 实打实的开销,而且 Supabase 的性能检查器会把它列为问题。

drop policy if exists organizations_select_creator on public.organizations;
drop policy if exists organizations_select_member on public.organizations;
create policy organizations_select_visible on public.organizations
  for select to authenticated
  -- 建了但还没来得及建成员关系的那一刻,创建者也要看得见自己的组织,
  -- 否则注册流程会在中间态卡死
  using ((created_by = (select auth.uid())) or private.is_org_member(id));

drop policy if exists profiles_select_self on public.profiles;
drop policy if exists profiles_select_org_peers on public.profiles;
create policy profiles_select_visible on public.profiles
  for select to authenticated
  using (
    (id = (select auth.uid()))
    or exists (
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

drop policy if exists memberships_insert_admin on public.memberships;
drop policy if exists memberships_insert_creator_bootstrap on public.memberships;
create policy memberships_insert_allowed on public.memberships
  for insert to authenticated
  with check (
    private.has_org_role(organization_id, array['owner','admin']::org_role[])
    -- 引导那一条:刚建完组织的人给自己建第一条 owner 成员关系。
    -- 没有它,新组织永远没有第一个成员 —— 而有它之前必须先是创建者,
    -- 所以不构成越权。
    or (
      user_id = (select auth.uid())
      and role = 'owner'
      and exists (
        select 1 from public.organizations o
        where o.id = public.memberships.organization_id
          and o.created_by = (select auth.uid())
      )
    )
  );

-- ── 二、把 FOR ALL 的写策略拆成显式三条 ─────────────────────
--
-- FOR ALL **也覆盖 SELECT**。它和已有的 *_select_member 叠在一起,
-- 就成了同一个动作上的两条宽松策略 —— 和上面那一类是同一个问题。
-- 拆开之后,读归读的策略管,写归写的策略管,各自只有一条。

drop policy if exists ai_providers_write_admin on public.ai_providers;
create policy ai_providers_insert_admin on public.ai_providers
  for insert to authenticated
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));
create policy ai_providers_update_admin on public.ai_providers
  for update to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]))
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));
create policy ai_providers_delete_admin on public.ai_providers
  for delete to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

drop policy if exists ai_models_write_admin on public.ai_models;
create policy ai_models_insert_admin on public.ai_models
  for insert to authenticated
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));
create policy ai_models_update_admin on public.ai_models
  for update to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]))
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));
create policy ai_models_delete_admin on public.ai_models
  for delete to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

-- ── 三、补外键索引 ─────────────────────────────────────────
--
-- messages.provider_id 指向 ai_providers。没有这个索引时,
-- 删除一个服务商要对 messages 全表扫描去查引用 —— 而 messages 是
-- 增长最快的表。用户在「模型服务」页删一个服务商就会卡住。
create index if not exists messages_provider_idx
  on public.messages (provider_id);

-- ── 核对方式 ───────────────────────────────────────────────
-- 应用后,下面两条的结果应当与生产库完全一致:
--
--   select policyname from pg_policies
--   where schemaname='public' order by policyname;
--
--   select indexname from pg_indexes
--   where schemaname='public' and indexname='messages_provider_idx';
--
-- 「语句执行成功」不等于「结果对」—— 0018 那次就是语句全成功、
-- 权限一点没变(列级 revoke 撤不掉表级授权)。必须查结果。
