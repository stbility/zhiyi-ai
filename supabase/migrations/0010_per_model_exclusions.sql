-- 0010 每个模型独立的删除记录
--
-- 起因是一次真实误判:此前「不可用」是服务商级的一个全局开关,
-- 用户删掉 deepseek-coder 时,毫无关联的 kimi-k2.6 也跟着消失。
-- 用户的原话:「请你不要把两个没有任何关联的模型绑定在一起」。
--
-- 所以做成每个模型一条记录 —— 删除是针对具体模型的决定,互不牵连。
-- 主键用 (provider_id, model_id):同一个模型在不同服务商下是两回事。
--
-- 注意:这份文件是从生产库反向导出补写的。0010 至 0014 五个迁移
-- 此前只存在于 Supabase 云端,仓库里没有 DDL —— 意味着数据库一旦丢失
-- 就无法从代码重建。补齐它们是为了让仓库重新成为唯一真值源。

create table if not exists public.ai_model_exclusions (
  provider_id     uuid not null references public.ai_providers(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  model_id        text not null,
  excluded_at     timestamptz not null default now(),
  primary key (provider_id, model_id)
);

create index if not exists ai_model_exclusions_org_idx
  on public.ai_model_exclusions (organization_id);

alter table public.ai_model_exclusions enable row level security;

-- 读:组织成员都能看到「哪些模型被删过」,否则界面上无法解释模型为何不见了
create policy ai_model_exclusions_select_member on public.ai_model_exclusions
  for select to authenticated
  using (private.is_org_member(organization_id));

-- 写:只有 owner / admin。删不删模型是管理决定,不是每个成员都能改的
create policy ai_model_exclusions_insert_admin on public.ai_model_exclusions
  for insert to authenticated
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

create policy ai_model_exclusions_update_admin on public.ai_model_exclusions
  for update to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]))
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

create policy ai_model_exclusions_delete_admin on public.ai_model_exclusions
  for delete to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]));
