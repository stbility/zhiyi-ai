-- =============================================================================
-- 0015 对话级项目附件(B4)
--
-- 此前附件只作用于发出的那一轮,正文不落库 —— 怕每条历史消息都背着几十 KB
-- 代码把上下文撑爆。但这让「智能体」这个定位落不了地:用户贴了项目目录,
-- 第二句问「改一下这个函数」,模型已经看不到代码,每轮都要重贴一遍。
-- 那不是智能体,是失忆的聊天框。
--
-- 正解是把附件挂在**对话**上而不是消息上:
--   - 每个文件只存一份,不随消息数量翻倍
--   - 每一轮都能看到完整项目上下文
--   - 换项目时整体替换,不残留上一个项目的文件
--
-- 至于「会不会撑爆上下文」——由预算分配解决(lib/ai/context.ts),不是靠不存。
--
-- 本文件与已应用到生产的迁移一致,仅作仓库留档。
-- =============================================================================

create table if not exists public.conversation_attachments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null
    references public.conversations (id) on delete cascade,
  organization_id uuid not null
    references public.organizations (id) on delete cascade,
  path text not null,
  content text not null,
  size_chars integer not null,
  created_at timestamptz not null default now(),
  unique (conversation_id, path)
);

create index if not exists conversation_attachments_conversation_idx
  on public.conversation_attachments (conversation_id);
create index if not exists conversation_attachments_organization_idx
  on public.conversation_attachments (organization_id);

alter table public.conversation_attachments enable row level security;

-- 单条策略覆盖读写,避免多条宽松策略(性能 linter 会报)
create policy conversation_attachments_own on public.conversation_attachments
  for all to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_attachments.conversation_id
        and c.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_attachments.conversation_id
        and c.user_id = (select auth.uid())
    )
  );
