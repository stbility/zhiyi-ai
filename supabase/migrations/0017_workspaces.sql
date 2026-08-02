-- 0017 工作区与工作区文件
--
-- 智能体和聊天助手的分界线:助手只能说,智能体能做。
-- 模型通过工具把产物写进这里,而不是把代码贴在对话气泡里等人复制。
--
-- 这份文件是从生产库反向导出补写的。此前它只有一行注释,正文写着
-- 「完整语句见 Supabase 迁移记录」—— 那等于把唯一真值源放在了云端,
-- 项目失去了灾难恢复能力,而且这几张表的 RLS 策略无人可审。

create table if not exists public.workspaces (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  -- 建者离职/注销时保留工作区本身,只把归属置空
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists workspaces_organization_idx
  on public.workspaces (organization_id);
create index if not exists workspaces_created_by_idx
  on public.workspaces (created_by);

create table if not exists public.workspace_files (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  -- 冗余存一份组织 id:RLS 要用它做隔离,不这样每次都得联表
  organization_id uuid not null references public.organizations(id) on delete cascade,
  path            text not null,
  content         text not null,
  size_chars      integer not null,
  -- 哪次对话写的。对话被删时只断开关联,文件本身留着 —— 产物不该跟着聊天记录消失
  written_by_conversation uuid references public.conversations(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- 同一路径重复写入即覆盖,这是 write_file 工具的语义
  unique (workspace_id, path)
);

create index if not exists workspace_files_workspace_idx
  on public.workspace_files (workspace_id, path);
create index if not exists workspace_files_organization_idx
  on public.workspace_files (organization_id);
create index if not exists workspace_files_conversation_idx
  on public.workspace_files (written_by_conversation);

-- 对话与工作区的关联。一次对话最多绑一个工作区,进同一个对话就接着往里写
alter table public.conversations
  add column if not exists workspace_id uuid
  references public.workspaces(id) on delete set null;

create index if not exists conversations_workspace_idx
  on public.conversations (workspace_id);

alter table public.workspaces enable row level security;
alter table public.workspace_files enable row level security;

-- 工作区:成员可读可建可改;删除是破坏性动作,限 owner / admin
create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using (private.is_org_member(organization_id));

create policy workspaces_insert_member on public.workspaces
  for insert to authenticated
  with check (private.is_org_member(organization_id));

create policy workspaces_update_member on public.workspaces
  for update to authenticated
  using (private.is_org_member(organization_id))
  with check (private.is_org_member(organization_id));

create policy workspaces_delete_admin on public.workspaces
  for delete to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

-- 文件:成员都能增删改查 —— 智能体代表用户写文件,限制到 admin 会让功能不可用
create policy workspace_files_select_member on public.workspace_files
  for select to authenticated
  using (private.is_org_member(organization_id));

create policy workspace_files_insert_member on public.workspace_files
  for insert to authenticated
  with check (private.is_org_member(organization_id));

create policy workspace_files_update_member on public.workspace_files
  for update to authenticated
  using (private.is_org_member(organization_id))
  with check (private.is_org_member(organization_id));

create policy workspace_files_delete_member on public.workspace_files
  for delete to authenticated
  using (private.is_org_member(organization_id));
