-- 0034 权益矩阵与查询(Entitlement Service)
--
-- 商业闭环第三步:套餐 → 权益 → 额度的静态映射。
--
-- 为什么是数据库表而不是代码常量:
--   权益矩阵是**商业配置**,不是工程配置。改价格/加档位/调额度
--   不该发版 —— 运营在 SQL Editor 里改一行就生效,CI 重放保证
--   生产与仓库一致。与 plans.ts 的分工:plans.ts 是**展示层**
--   (名字、价格文案、feature 列表),entitlements 是**判断层**
--   (feature 是否存在、quota 是多少)。判断必须走数据库,
--   展示可以走代码 —— 展示错了用户看得见,判断错了是越权。
--
-- 【安全模型】
--   get_entitlements 是 security definer:查询订阅状态时,
--   用调用者的 user_id 参数,不信任客户端传入的 plan_id。
--   无订阅行 = free(默认档),这是最重要的兜底 ——
--   漏配订阅绝不允许等于漏配权益。
--
-- 【纯新增】不改现有表策略。风险最低一档。

-- 权益矩阵:plan_id × feature → quota。
-- quota 语义:null = 无上限(如 enterprise 的工作流数),数字 = 额度上限。
-- 额度单位由 feature 名约定:workflows=个数, monthly_agent_turns=次数/月
create table if not exists public.entitlements (
  plan_id     text not null
    check (plan_id in ('free','professional','professional_plus','team','enterprise')),
  feature     text not null,
  quota       integer,  -- null = 不限制
  primary key (plan_id, feature)
);

alter table public.entitlements enable row level security;

-- 静态配置表,任何人都能读(不含隐私);写只走 SQL Editor/迁移,
-- 不建任何 INSERT/UPDATE/DELETE 策略 —— RLS 默认拒绝即正确
create policy entitlements_select_all on public.entitlements
  for select to authenticated
  using (true);

-- 默认权益。决策输入(以 Stripe 为准,价格不在此表):
--   Free    HK$0/月      workflows=1,   monthly_agent_turns=200
--   Pro     HK$128/月   workflows=5,   monthly_agent_turns=500
--   Pro+    HK$198/月   workflows=10,  monthly_agent_turns=2000
--   Team    HK$388/月   workflows=30,  monthly_agent_turns=5000
--   Ent     自定义      workflows=null(不限), monthly_agent_turns=5000
insert into public.entitlements (plan_id, feature, quota) values
  ('free',         'workflows',            1),
  ('free',         'monthly_agent_turns',  200),
  ('professional', 'workflows',            5),
  ('professional', 'monthly_agent_turns',  500),
  ('professional_plus','workflows',       10),
  ('professional_plus','monthly_agent_turns', 2000),
  ('team',         'workflows',           30),
  ('team',         'monthly_agent_turns',  5000),
  ('enterprise',   'workflows',            null),
  ('enterprise',   'monthly_agent_turns',  5000)
on conflict (plan_id, feature) do nothing;

-- 查询用户当前权益。无订阅 = free。
-- security definer:函数体内以函数 owner 身份执行。
-- 【越权修复】此前信任调用者传入的 p_user_id —— RPC 是公开 HTTP 面,
-- 任意登录用户可查任意 user_id 的套餐。函数体改为强制
-- auth.uid() 作为查询主体:参数保留以兼容应用层调用签名,
-- 但函数内只认 (select auth.uid())。调用方传别人的 id 也查不到。
create or replace function public.get_entitlements(p_user_id uuid)
returns table (
  plan_id       text,
  feature       text,
  quota         integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.plan_id, e.feature, e.quota
  from public.entitlements e
  where e.plan_id = coalesce(
    (select s.plan_id from public.subscriptions s
     where s.user_id = (select auth.uid())
       and s.status in ('active', 'trialing')
     order by s.created_at desc
     limit 1),
    'free'
  );
$$;

-- EXECUTE 只给 authenticated(登录用户),service_role 天然可调
revoke execute on function public.get_entitlements(p_user_id uuid) from public, anon;
grant execute on function public.get_entitlements(p_user_id uuid) to authenticated;
