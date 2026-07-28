-- =============================================================================
-- Phase 3 · 对话与消息
--
-- 每次模型调用都必须留痕:用了哪个 Provider、哪个模型、耗时多少、
-- 消耗多少 token、成功还是失败。这是需求第四章的硬性要求,
-- 也是后续做用量计费与权益控制的唯一依据。
-- =============================================================================

create table if not exists public.conversations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  title            text not null default '新对话' check (length(title) between 1 and 200),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.conversations enable row level security;
create index if not exists conversations_user_idx
  on public.conversations (user_id, updated_at desc);

create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  role             text not null check (role in ('user', 'assistant', 'system')),
  content          text not null default '',
  provider_id      uuid references public.ai_providers (id) on delete set null,
  model_id         text,
  input_tokens     integer check (input_tokens is null or input_tokens >= 0),
  output_tokens    integer check (output_tokens is null or output_tokens >= 0),
  latency_ms       integer check (latency_ms is null or latency_ms >= 0),
  error_message    text,
  created_at       timestamptz not null default now()
);
alter table public.messages enable row level security;
create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at);

-- 对话属于个人:同组织其他成员也看不到别人的对话
drop policy if exists conversations_own on public.conversations;
create policy conversations_own on public.conversations
  for all to authenticated
  using (user_id = auth.uid() and public.is_org_member(organization_id))
  with check (user_id = auth.uid() and public.is_org_member(organization_id));

drop policy if exists messages_own on public.messages;
create policy messages_own on public.messages
  for all to authenticated
  using (
    exists (select 1 from public.conversations c
            where c.id = messages.conversation_id and c.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.conversations c
            where c.id = messages.conversation_id and c.user_id = auth.uid())
  );

drop trigger if exists conversations_touch on public.conversations;
create trigger conversations_touch before update on public.conversations
  for each row execute function public.touch_updated_at();
