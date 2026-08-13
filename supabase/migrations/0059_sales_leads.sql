-- 0063 Enterprise 销售线索
--
-- P0-3 修正:定价页 Enterprise「联系销售」此前直接跳硬编码 Stripe Payment
-- Link(且与 Team 共用同一 URL),用户看到的是付款页而不是询价流程;
-- 付款邮箱≠注册邮箱时订阅还会静默丢失。
--
-- 现在改为站内询价表单(/contact),提交落到本表,由销售人工跟进。
-- 【纯新增】不改任何现有表、策略、授权。风险最低的一档。

create table if not exists public.sales_leads (
  id            uuid primary key default gen_random_uuid(),
  company_name  text not null,
  contact_name  text not null,
  email         text not null,
  team_size     text,
  scale         text,
  description   text not null,
  plan_id       text not null default 'enterprise',
  -- new → contacted → qualified → won / lost
  status        text not null default 'new',
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists sales_leads_status_idx
  on public.sales_leads (status, created_at desc);

alter table public.sales_leads enable row level security;

-- 读:只有提交者本人可见(线索含联系方式,默认不向组织其他成员开放;
-- 销售跟进走 service_role / 后台,见 docs/backup-restore.md 同款模式)
create policy sales_leads_select_self on public.sales_leads
  for select to authenticated
  using (created_by = (select auth.uid()));

-- 写:登录用户可提交;created_by 强制绑定当前用户,不接受客户端伪造
create policy sales_leads_insert_self on public.sales_leads
  for insert to authenticated
  with check (created_by = (select auth.uid()));

comment on table public.sales_leads is
  'Enterprise 询价线索。「联系销售」表单提交落这里,status 由人工跟进流转';
