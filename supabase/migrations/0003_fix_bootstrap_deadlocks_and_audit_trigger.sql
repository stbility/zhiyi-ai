-- =============================================================================
-- Phase 1 修正 · 组织创建的引导死锁,以及审计日志的写入方式
--
-- 这三个缺陷都是在真实走通「注册 → 登录 → 创建组织」链路时暴露的。
-- 0001 的 RLS 验证只覆盖了反例(冒名创建被拒),没有跑正例的完整链路,
-- 因此没能发现:策略本身是对的,但组合起来存在引导阶段互相锁死。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 缺陷一:创建者读不到自己刚创建的组织
--
-- 应用创建组织时用 INSERT ... RETURNING(需要拿回 id 去建成员关系),
-- 而 PostgreSQL 会对 RETURNING 返回的行额外套用 SELECT 策略。
-- 原 SELECT 策略要求「必须是本组织成员」,此刻成员关系还不存在 → 整条插入被判违规。
--
-- 死锁:建组织要能读回 → 能读回要先是成员 → 成为成员要组织先存在。
--
-- 修复不放宽任何隔离:读的是自己亲手创建的组织。
-- -----------------------------------------------------------------------------
drop policy if exists organizations_select_creator on public.organizations;
create policy organizations_select_creator on public.organizations
  for select to authenticated
  using (created_by = auth.uid());

-- -----------------------------------------------------------------------------
-- 缺陷二:创建者无法把自己登记为第一个成员
--
-- memberships 的 INSERT 策略要求调用者已是 owner/admin,但新组织一个成员都没有,
-- 于是第一条成员关系永远插不进去。
--
-- 引导策略收得很窄,三个条件同时满足才放行:
--   1. 只能加「自己」
--   2. 角色只能是 owner
--   3. 该组织必须是自己创建的
-- 因此无法用它加入他人组织,也无法给他人授权。
-- -----------------------------------------------------------------------------
drop policy if exists memberships_insert_creator_bootstrap on public.memberships;
create policy memberships_insert_creator_bootstrap on public.memberships
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and role = 'owner'
    and exists (
      select 1
      from public.organizations o
      where o.id = memberships.organization_id
        and o.created_by = auth.uid()
    )
  );

-- -----------------------------------------------------------------------------
-- 缺陷三:审计日志原本由应用层写入
--
-- audit_logs 没有(也不应有)面向 authenticated 的 INSERT 策略 —— 客户端若能
-- 自由写审计表就能伪造轨迹。原应用代码去插 audit_logs,必然失败,且方向就是错的。
--
-- 改为触发器写入:
--   1. 应用层跳不过 —— 不依赖某段代码「记得写日志」
--   2. 客户端伪造不了 —— 只有触发器以 definer 身份写
--   3. 配合既有的「无 update/delete 策略」,审计记录只增不改不删
-- -----------------------------------------------------------------------------
create or replace function public.log_organization_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    new.id,
    new.created_by,
    'organization.create',
    'organization',
    new.id::text,
    jsonb_build_object('name', new.name, 'slug', new.slug)
  );
  return new;
end;
$$;

revoke all on function public.log_organization_created() from public, anon, authenticated;

drop trigger if exists organizations_audit_create on public.organizations;
create trigger organizations_audit_create
  after insert on public.organizations
  for each row execute function public.log_organization_created();
