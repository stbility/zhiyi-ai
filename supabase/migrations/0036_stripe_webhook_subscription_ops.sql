-- 0036_stripe_webhook_subscription_ops.sql
-- Stripe Webhook 的订阅写操作函数(service role)。
--
-- 幂等:stripe_subscription_id 有 unique 约束,重复 upsert 不会产生重复记录。
-- 找不到用户时记录日志并退出(非用户触发的支付如匿名 Payment Link 不应报错)。

-- upsert 订阅记录。
-- p_customer_email: Stripe 事件中的 customer_email(Payment Link) 或 customer_details.email
-- p_stripe_subscription_id: subscription ID(Payment Link 可能为空字符串,此时跳过)
create or replace function public.upsert_stripe_subscription(
  p_customer_email          text,
  p_stripe_customer_id     text default null,
  p_stripe_subscription_id text default null,
  p_status                 text,
  p_plan_id                text,
  p_current_period_end     timestamptz default null,
  p_cancel_at_period_end   boolean    default false
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if p_customer_email is null or p_customer_email = '' then
    raise notice 'upsert_stripe_subscription: no customer_email, skipping';
    return;
  end if;

  -- 通过 email 找用户
  select id into v_user_id
  from auth.users
  where lower(email) = lower(p_customer_email)
  limit 1;

  if v_user_id is null then
    raise notice 'upsert_stripe_subscription: user not found for email=%', p_customer_email;
    return;
  end if;

  -- upsert stripe_customers(首次支付时建立映射)
  if p_stripe_customer_id is not null and p_stripe_customer_id != '' then
    insert into public.stripe_customers (user_id, customer_id, updated_at)
    values (v_user_id, p_stripe_customer_id, now())
    on conflict (user_id) do update
      set customer_id = p_stripe_customer_id, updated_at = now();
  end if;

  -- upsert subscriptions(幂等;Payment Link 可能无 subscription_id)
  if p_stripe_subscription_id is not null and p_stripe_subscription_id != '' then
    insert into public.subscriptions (
      user_id, stripe_subscription_id, status, plan_id,
      current_period_end, cancel_at_period_end
    )
    values (
      v_user_id, p_stripe_subscription_id, p_status, p_plan_id,
      p_current_period_end, p_cancel_at_period_end
    )
    on conflict (stripe_subscription_id) do update
      set
        status              = excluded.status,
        plan_id             = excluded.plan_id,
        current_period_end  = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        updated_at          = now();
  end if;

end;
$$;

grant execute on function public.upsert_stripe_subscription(
  text, text, text, text, text, timestamptz, boolean
) to service_role;
