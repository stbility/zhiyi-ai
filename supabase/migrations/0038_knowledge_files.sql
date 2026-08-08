-- 0038 知识库文件
--
-- 知识库 = 组织文档的解析与索引。状态机与设计系统 KnowledgeFileRow
-- 的 5 态对齐:uploading → parsing → indexing → ready / failed。
-- v1 执行模型(如实说明):上传后在同一请求里解析+建索引(同步),
-- 状态瞬时流转;真正的后台队列后续上线。向量检索待 embedding 服务,
-- v1 用 content_text 全文(ILIKE)检索,检索与注入都基于文本。

create table if not exists public.knowledge_files (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 255),
  file_type       text not null check (file_type in ('pdf','docx','md','txt','other')),
  size_bytes      integer not null check (size_bytes >= 0),
  status          text not null default 'uploading' check (
    status in ('uploading','parsing','indexing','ready','failed')
  ),
  error           text,
  content_text    text not null default '',
  created_by      uuid not null references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists knowledge_files_org_idx on public.knowledge_files (organization_id);

-- RLS:成员可读;创建者本人可改/删;写操作以 auth.uid() 落 created_by。
alter table public.knowledge_files enable row level security;

create policy knowledge_files_select_member on public.knowledge_files
  for select to authenticated
  using (private.is_org_member(organization_id));

create policy knowledge_files_insert_member on public.knowledge_files
  for insert to authenticated
  with check (
    private.is_org_member(organization_id)
    and created_by = (select auth.uid())
  );

create policy knowledge_files_update_own on public.knowledge_files
  for update to authenticated
  using (created_by = (select auth.uid()))
  with check (
    created_by = (select auth.uid())
    and private.is_org_member(organization_id)
  );

create policy knowledge_files_delete_own on public.knowledge_files
  for delete to authenticated
  using (created_by = (select auth.uid()));
