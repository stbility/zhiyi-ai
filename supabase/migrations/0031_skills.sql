-- 0031 SKILL 技能库
--
-- 智一智能体的「技能库」:对齐 Hermes Agent 的 SKILL.md 规范 ——
-- 同一份技能文件(名称、描述、正文、附件)在 Hermes 本地和 zhiyi-ai 产品
-- 两端都能跑。这是产品独立于 Hermes 的第二步:技能不再是 Hermes 的私有资产,
-- 而是产品的数据。
--
-- 对齐点(与 Hermes SKILL.md frontmatter 一一对应):
--   name          → slug,如 weekly-report
--   description   → 一句话触发条件,agent 靠它判断何时加载(同 Hermes 的
--                  system prompt 技能索引 —— 只给名称+描述,正文按需加载)
--   version       → 技能版本,升级可追踪
--   author/license/platforms/tags/related_skills → 元数据
--   body          → SKILL.md 正文(frontmatter 之后的部分)
--   skill_files   → 附件的 references/ templates/ scripts/ —— 与 Hermes 的
--                  linked_files 同构,支持技能携带脚本与模板
--
-- 与 memories(0028)的分工:
--   memories 是「事实/偏好/约定」—— 用户确认的陈述性知识
--   skills   是「怎么做」—— 可执行的方法论与工作流
--   模型先 skill_list 看到有什么,再 skill_view 加载需要的,照章执行。
--
-- 【纯新增】不改任何现有表、策略、授权。风险最低的一档。

create table if not exists public.skills (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- slug。工具与技能页都用它定位,必须唯一
  name            text not null,
  title           text not null,
  -- 一句话触发条件。agent 的技能索引只展示 name + description,
  -- 靠它判断「现在该不该加载这个技能」—— 与 Hermes 完全一致
  description     text not null,
  version         text not null default '1.0.0',
  author          text,
  license         text not null default 'MIT',
  platforms       text[] not null default '{linux,macos,windows}',
  tags            text[] not null default '{}',
  related_skills  text[] not null default '{}',
  -- SKILL.md 正文(frontmatter 之后的 markdown 主体)
  body            text not null,
  -- 是否参与加载。关闭的技能在 skill_list 里不出现,但保留 ——
  -- 关了还能再开,删了就得重新导入
  enabled         boolean not null default true,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name)
);

create index if not exists skills_organization_idx
  on public.skills (organization_id);
create index if not exists skills_created_by_idx
  on public.skills (created_by);

-- 技能附件:references/ templates/ scripts/。与 Hermes 的 linked_files 同构
create table if not exists public.skill_files (
  id          uuid primary key default gen_random_uuid(),
  skill_id    uuid not null references public.skills(id) on delete cascade,
  -- 附件路径,如 references/api.md / scripts/validate.py
  path        text not null,
  content     text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (skill_id, path)
);

create index if not exists skill_files_skill_idx
  on public.skill_files (skill_id);

alter table public.skills enable row level security;
alter table public.skill_files enable row level security;

-- 读:组织成员都能看到技能。技能是团队资产,不是管理员的私有物
create policy skills_select_member on public.skills
  for select to authenticated
  using (private.is_org_member(organization_id));

-- 写:只有 owner / admin。导入技能 = 向 agent 注入方法论,是管理决定
create policy skills_insert_admin on public.skills
  for insert to authenticated
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

create policy skills_update_admin on public.skills
  for update to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]))
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

create policy skills_delete_admin on public.skills
  for delete to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

-- 附件跟着技能走:能读技能就能读附件,能写技能才能写附件
create policy skill_files_select_member on public.skill_files
  for select to authenticated
  using (
    exists (
      select 1 from public.skills s
      where s.id = skill_files.skill_id
        and private.is_org_member(s.organization_id)
    )
  );

create policy skill_files_insert_admin on public.skill_files
  for insert to authenticated
  with check (
    exists (
      select 1 from public.skills s
      where s.id = skill_files.skill_id
        and private.has_org_role(s.organization_id, array['owner','admin']::org_role[])
    )
  );

create policy skill_files_update_admin on public.skill_files
  for update to authenticated
  using (
    exists (
      select 1 from public.skills s
      where s.id = skill_files.skill_id
        and private.has_org_role(s.organization_id, array['owner','admin']::org_role[])
    )
  )
  with check (
    exists (
      select 1 from public.skills s
      where s.id = skill_files.skill_id
        and private.has_org_role(s.organization_id, array['owner','admin']::org_role[])
    )
  );

create policy skill_files_delete_admin on public.skill_files
  for delete to authenticated
  using (
    exists (
      select 1 from public.skills s
      where s.id = skill_files.skill_id
        and private.has_org_role(s.organization_id, array['owner','admin']::org_role[])
    )
  );

comment on table public.skills is
  'SKILL 技能库:对齐 Hermes SKILL.md 规范的方法论库。skill_list 展示索引,skill_view 按需加载';
comment on table public.skill_files is
  '技能附件(references/templates/scripts),与 Hermes linked_files 同构';
