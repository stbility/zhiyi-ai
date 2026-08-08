-- 0028 智能体记忆
--
-- 五条闭环的最后一环:「沉淀为记忆」。
--
--   1 输入资料   → 文件上传 + 跨轮保留
--   2 AI Agent  → 多步工具循环,产物写工作区
--   3 结果引用  → 工具结果截断标注 (agent.ts capToolResult)
--   4 用户确认  → message_feedback (0020) —— 用户对哪条回答打了分/改了样
--   5 沉淀记忆  → 本迁移:确认过的内容存成记忆,可召回、可编辑、可删除
--
-- 为什么是单独一张表而不是塞进 message_feedback:
--   反馈是「这条回答好不好」,记忆是「这个事实/偏好/约定要长期记住」。
--   一条回答可以没有反馈,但用户可能想记住它;一条反馈可以很好,
--   但内容未必值得长期保留。生命周期也不同:反馈是评测样本,
--   记忆是要在后续对话里被召回的。混在一张表里,两边都别扭。
--
-- 来源纪律 (source_type):
--   用户确认的 (user_confirmed) 是最高置信 —— 用户亲手点的「记住」。
--   其余类型 (ai_inferred / from_file / from_workflow) 是 AI 推断的,
--   必须带 confidence 且界面上不许伪装成用户确认的事实。
--   这条规则与营销页「每条记忆都标明来源」的承诺一致:
--   来源必须如实,未确认的不得标记为已确认。
--
-- 【纯新增】不改任何现有表、策略、授权。与 0027 同类,风险最低的一档。

create table if not exists public.memories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- 从哪条对话/哪条消息沉淀来的。对话被删只断开关联,记忆本身留着 ——
  -- 用户确认过的事实不该跟着聊天记录消失
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id      uuid references public.messages(id) on delete set null,
  created_by      uuid not null references auth.users(id) on delete cascade,
  -- 记忆的分类。不用 enum:分类会演化,check 约束改起来没有依赖负担
  category        text not null default 'fact'
    check (category in ('fact','preference','convention','knowledge','persona')),
  content         text not null,
  -- 来源类型。user_confirmed 是唯一可信来源,其余必须有 confidence
  source_type     text not null default 'user_confirmed'
    check (source_type in ('user_confirmed','ai_inferred','from_file','from_workflow')),
  -- AI 推断的记忆的置信度。用户确认的记忆没有置信度 —— 用户的话就是事实
  confidence      numeric check (confidence >= 0 and confidence <= 1),
  -- 作用域:组织级(全员可见)还是仅创建者
  scope           text not null default 'organization'
    check (scope in ('organization','user')),
  -- 是否参与召回。用户可以在界面上关掉某条记忆的召回,
  -- 但记忆本身保留 —— 关了还能再开,删了就得重新沉淀
  recall_enabled  boolean not null default true,
  -- 最近一次被召回进上下文的时间。召回逻辑靠它做优先级排序
  last_used_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists memories_organization_idx
  on public.memories (organization_id);
create index if not exists memories_conversation_idx
  on public.memories (conversation_id);
create index if not exists memories_created_by_idx
  on public.memories (created_by);
-- 召回查询:按组织 + 启用状态 + 最近使用排序
create index if not exists memories_recall_idx
  on public.memories (organization_id, recall_enabled, last_used_at desc);

alter table public.memories enable row level security;

-- 读:组织成员都能看到组织级记忆。用户级记忆只有创建者能看到。
create policy memories_select_member on public.memories
  for select to authenticated
  using (
    private.is_org_member(organization_id)
    and (scope = 'organization' or created_by = (select auth.uid()))
  );

-- 写:只能写自己的记忆,且必须是本组织成员
create policy memories_insert_own on public.memories
  for insert to authenticated
  with check (
    private.is_org_member(organization_id)
    and created_by = (select auth.uid())
  );

create policy memories_update_own on public.memories
  for update to authenticated
  using (created_by = (select auth.uid()))
  with check (
    created_by = (select auth.uid())
    and private.is_org_member(organization_id)
  );

create policy memories_delete_own on public.memories
  for delete to authenticated
  using (created_by = (select auth.uid()));

-- 召回函数:取本组织启用召回的记忆,按最近使用优先,最多 limit 条。
-- 服务端调用,不走客户端 —— 上下文装配发生在服务端。
-- security definer 因为要绕过 RLS 被调用方拿全量再自行过滤?不 ——
-- 这里显式带 organization_id 参数,调用方只传自己的组织,拿不到别人的。
-- 用 security invoker + RLS 即可:服务端 client 有自己的角色,
-- RLS 的 auth.uid() 在服务端为空,所以这里不用 RLS 而是显式过滤。
-- 因此定义成 security definer 并固定以调用者传入的 org 为准。
--
-- 【越权修复】RPC 端点是公开 HTTP 面,"调用方只传自己的组织"不是
-- 安全边界 —— 任意登录用户可传任意 org_id。函数体必须用
-- auth.uid() 校验调用者确是该组织在职成员;并过滤 scope='user'
-- 的私密记忆(组织级召回不该把他人私密记忆带出去)。
-- 同时补 revoke from public,anon:Postgres 默认 PUBLIC 有 EXECUTE,
-- 否则未登录用户也能调(0002 修过的坑,这里又犯了一次)。
create or replace function public.recall_memories(
  p_organization_id uuid,
  p_limit integer default 10
) returns table (
  id uuid,
  category text,
  content text,
  source_type text,
  confidence numeric,
  last_used_at timestamptz
) language sql security definer set search_path = '' as $$
  select m.id, m.category, m.content, m.source_type, m.confidence, m.last_used_at
  from public.memories m
  where m.organization_id = p_organization_id
    and m.recall_enabled = true
    -- 只回组织级记忆:成员私密记忆不随组织召回流出
    and m.scope = 'organization'
    -- 调用者必须是该组织在职成员(auth.uid() 绑定,参数改不了)
    and exists (
      select 1 from public.memberships ms
      where ms.organization_id = p_organization_id
        and ms.user_id = (select auth.uid())
        and ms.status = 'active'
    )
  order by m.last_used_at desc nulls last, m.created_at desc
  limit p_limit;
$$;

-- 召回成功后更新 last_used_at,让召回按使用频率自适应
create or replace function public.touch_memory(p_memory_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.memories
  set last_used_at = now()
  where id = p_memory_id
    -- 只能碰自己的记忆(或本组织成员的组织级记忆)
    and (
      created_by = (select auth.uid())
      or exists (
        select 1 from public.memberships ms
        where ms.organization_id = memories.organization_id
          and ms.user_id = (select auth.uid())
          and ms.status = 'active'
      )
    );
$$;

-- 越权修复:0002 的坑 —— 新建函数默认 PUBLIC 有 EXECUTE,必须显式收回
revoke all on function public.recall_memories(uuid, integer) from public, anon;
revoke all on function public.touch_memory(uuid) from public, anon;
grant execute on function public.recall_memories(uuid, integer) to authenticated;
grant execute on function public.touch_memory(uuid) to authenticated;
