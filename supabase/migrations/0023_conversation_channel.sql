-- 对话归属到哪条通道。
--
-- 智一 AI 有两条通道,它们是两种不同的工作:
--   chat   AI 助手 —— 想清楚一件事,不产生副作用
--   agent  智能体  —— 干成一件事,产物写进工作区
--
-- 这是 Claude 的分法:claude.ai 是思考伙伴,Claude Code 是工程师。
-- 两边的历史记录不该混在一个列表里 —— 用户去智能体页面是想接着昨天那个
-- 没跑完的任务,不是想翻昨天问过的一个概念题。
--
-- 默认 chat:已有的对话全部是 AI 助手产生的(智能体此前也走同一个端点,
-- 但它当时并不单独成一条通道)。把历史一律归到 chat 是如实的 ——
-- 说它们是智能体会话才是编的。
alter table public.conversations
  add column if not exists channel text not null default 'chat';

-- 只允许这两个值。
--
-- 用 check 而不是 enum:将来加通道(比如接 OpenClaw 之后的「外部智能体」)
-- 时,改 check 约束不需要处理 enum 类型的依赖。
alter table public.conversations
  drop constraint if exists conversations_channel_check;
alter table public.conversations
  add constraint conversations_channel_check
  check (channel in ('chat', 'agent'));

-- 两个页面各自只列自己通道的对话,而且都按组织 + 时间倒序取。
-- 没有这个索引,每次进页面都要全表扫再过滤。
create index if not exists conversations_org_channel_created_idx
  on public.conversations (organization_id, channel, created_at desc);

comment on column public.conversations.channel is
  '这个对话属于哪条通道:chat = AI 助手(无副作用),agent = 智能体(写工作区)。两边的历史列表互不可见。';
