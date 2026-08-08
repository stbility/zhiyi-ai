-- 0020 回答反馈
--
-- 这是「反馈飞轮」的第一块,也是整条链路上唯一一件**现在不做以后补不回来**的事:
-- 历史对话随时能回捞,但用户当时想把这句话改成什么,过后没人记得。
--
-- edited_text 是含金量最高的一列 —— 它直接给出「模型写的」和「用户要的」
-- 之间的差。既能当评测用例,也是将来微调的成对样本。
-- 只有 👍/👎 的话,你知道好坏却不知道该往哪个方向改。
--
-- 一人一条:unique (message_id, created_by)。改主意就更新那一条,
-- 不留一串互相矛盾的记录。

create table if not exists public.message_feedback (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  verdict text not null check (verdict in ('good','bad','edited')),
  -- 用户改成了什么。verdict='edited' 时才有值
  edited_text text,
  reason text,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, created_by)
);

create index if not exists message_feedback_organization_idx
  on public.message_feedback (organization_id);
create index if not exists message_feedback_message_idx
  on public.message_feedback (message_id);
create index if not exists message_feedback_created_by_idx
  on public.message_feedback (created_by);

alter table public.message_feedback enable row level security;

-- 读:组织成员都能看到 —— 反馈是团队资产,后面要用它做评测集
create policy message_feedback_select_member on public.message_feedback
  for select to authenticated
  using (private.is_org_member(organization_id));

-- 写:只能写自己的。created_by 必须等于当前用户,不能替别人打分
-- 【M2 修复】补 message_id 归属校验:此前只验 org 成员 + created_by,
-- 未校验 message_id 属于该组织 —— 用户可对任意 message_id(含别家
-- 组织的消息)插入反馈行,破坏跨组织引用完整性。这里要求被反馈的
-- 消息必须与反馈行属于同一组织。
create policy message_feedback_insert_own on public.message_feedback
  for insert to authenticated
  with check (
    private.is_org_member(organization_id)
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.messages m
      where m.id = message_id
        and m.organization_id = public.message_feedback.organization_id
    )
  );

create policy message_feedback_update_own on public.message_feedback
  for update to authenticated
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));

create policy message_feedback_delete_own on public.message_feedback
  for delete to authenticated
  using (created_by = (select auth.uid()));
