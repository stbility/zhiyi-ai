-- 0073 get_entitlements_by_user_id — Runner 权益查询
--
-- 问题：get_entitlements() 函数体内使用 auth.uid()，
--       Runner 以 service_role 连接，auth.uid() = NULL，
--       导致所有用户权益查询结果都是 'free'。
--
-- 解决：新建 get_entitlements_by_user_id(p_user_id uuid)，
--       接受显式 user_id 参数，专供 Runner / service_role 进程调用。
--
-- 注意：entitlements.ts 的 getMyEntitlements() 继续走 get_entitlements()
--       (auth.uid() 路径)，保持原有安全边界。
--       新函数只给 Runner 等 service_role 进程用。

create or replace function public.get_entitlements_by_user_id(p_user_id uuid)
returns table (
  plan_id       text,
  feature       text,
  quota         integer
)
language sql
stable
set search_path = ''
as $$
  select e.plan_id, e.feature, e.quota
  from public.entitlements e
  where e.plan_id = coalesce(
    (select s.plan_id from public.subscriptions s
     where s.user_id = p_user_id
       and s.status in ('active', 'trialing')
     order by s.created_at desc
     limit 1),
    'free'
  );
$$;

-- service_role 可调用（Runner 通过 Pooler 以用户身份连接，
-- bump_usage auth 校验在函数层解决，不在此函数重复校验）
grant execute on function public.get_entitlements_by_user_id(uuid) to authenticated, service_role;
