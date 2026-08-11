-- 0046_supabase_advisors_security.sql
-- Supabase Security Advisor 8 条告警修复(2026-08-10,官方做法逐条对应):
--   [1] 公共扩展 vector → extensions schema(官方约定:扩展装 extensions schema,
--       不污染 public;https://supabase.com/docs/guides/database/extensions)
--   [2-7] 6 个 SECURITY DEFINER 函数 → SECURITY INVOKER(函数体自限定 auth.uid() +
--        表 RLS 已覆盖:subscriptions select_own / usage_metering select_own /
--        memories select_member+update_own / entitlements select_all;
--        bump_usage 的写操作补 usage_metering insert/update 策略)
--   [8] 泄露密码保护 = Supabase Dashboard 开关(Auth → Security),非迁移,
--       见 MANIFEST.md 备注。用户侧打开:启用 Leaked password protection。

-- ── [1] vector 扩展 → extensions schema ────────────────────────────────
create schema if not exists extensions;
alter extension vector set schema extensions;

-- ⚠️ search_memories 函数体里显式 OPERATOR(public.<=>),扩展移动后 public.<=>
-- 不再解析 → 必须重建为 extensions.<=>;类型限定也用 extensions.vector。
create or replace function public.search_memories(
  p_embedding extensions.vector(1536),
  p_limit integer default 8
) returns table (
  id uuid,
  organization_id uuid,
  category text,
  content text,
  source_type text,
  confidence numeric,
  scope text,
  recall_enabled boolean,
  last_used_at timestamptz,
  created_at timestamptz,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.id, m.organization_id, m.category, m.content, m.source_type,
         m.confidence, m.scope, m.recall_enabled, m.last_used_at, m.created_at,
         1 - (m.embedding OPERATOR(extensions.<=>) p_embedding) as similarity
  from public.memories m
  where m.embedding is not null
    and m.recall_enabled
    and private.is_org_member(m.organization_id)
    and (m.scope = 'organization' or m.created_by = (select auth.uid()))
  order by m.embedding OPERATOR(extensions.<=>) p_embedding
  limit p_limit;
$$;

revoke execute on function public.search_memories(extensions.vector, integer) from public, anon;
grant execute on function public.search_memories(extensions.vector, integer) to authenticated;

-- ── [2-7] 其余 5 个 SECURITY DEFINER → SECURITY INVOKER ─────────────────
-- 函数体不改:全部已自限定 auth.uid()(bump_usage 抛「无权操作其他用户的用量」、
-- recall 成员绑定、touch 所有权、get_entitlements 只认 auth.uid() 的订阅、
-- get_monthly_usage 只读调用者),INVOKER 后由表 RLS 做同等的行级约束。
alter function public.get_entitlements(uuid) security invoker;
alter function public.get_monthly_usage(uuid, text) security invoker;
alter function public.recall_memories(uuid, integer) security invoker;
alter function public.touch_memory(uuid) security invoker;
alter function public.bump_usage(uuid, text, integer) security invoker;

-- bump_usage 由 DEFINER 改 INVOKER 后,调用者(authenticated)直接写
-- usage_metering → 需补行级写策略(仅限自己的行,与 select_own 同口径)。
create policy usage_metering_insert_own on public.usage_metering
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy usage_metering_update_own on public.usage_metering
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
