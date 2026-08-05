-- 0027 智能体运行记录与逐步检查点
--
-- 【要解决的真实故障】
-- 用户实测:智能体成功执行了 git_list_files、读回了目录,然后请求在
-- 102 秒时超时中断 —— **读到的目录直接消失,连"发生过"都没有痕迹**。
--
-- 根因不是工具坏了(白名单、令牌、仓库发现全部正常),是执行模型:
--   · 工具结果只累积在浏览器的 React state 里(ChatPanel 的 ranTools)
--   · 落库只发生在 runAgent() **完整返回之后**
--   · 失败路径只写一条空消息
--   · messages 的 role 约束是 ('user','assistant','system') ——
--     连把工具结果当消息存都做不到
--
-- 也就是说:整轮工作要么全部保住,要么全部丢掉。而模型越慢、任务越长,
-- 撞上 300 秒平台上限的概率越高 —— 越是有价值的长任务越容易全丢。
--
-- 【为什么是两张表】
-- 运行状态和步骤明细的写入频率、生命周期完全不同:
--   agent_runs   一轮一行,状态反复更新
--   agent_steps  一步一行,只追加不修改
-- 合成一张的话,要么用 jsonb 数组反复重写整列(并发下互相覆盖),
-- 要么状态列被步骤行重复冗余。
--
-- 【纯新增】
-- 不改任何现有表、策略、授权。这是所有 schema 变更里风险最低的一类。

create table if not exists public.agent_runs (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- 用哪个服务商/模型跑的。平台免费档没有 ai_providers 行,所以可空
  provider_id     uuid references public.ai_providers(id) on delete set null,
  model_id        text,
  -- 八态。分这么细是因为「卡在哪一环」决定了怎么恢复:
  --   waiting_model 卡在模型生成 → 重发同一轮
  --   running_tool  卡在工具执行 → 该工具可能已经产生副作用,不能盲目重跑
  --   interrupted   请求被平台杀掉,状态停在半路 → 可续
  -- 混成一个 running 的话,恢复时只能靠猜。
  status          text not null default 'queued'
    check (status in ('queued','running','waiting_model','running_tool',
                      'interrupted','completed','failed','cancelled')),
  -- 已经完成到第几步。恢复时从这里往后续,前面的不重跑
  current_step    integer not null default 0,
  started_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  error_message   text,
  -- 能不能续。已经开出 PR 的那种运行不该被续 ——
  -- 重跑 git_propose_changes 会创建第二个分支
  resumable       boolean not null default true
);

create index if not exists agent_runs_conversation_idx
  on public.agent_runs (conversation_id);
create index if not exists agent_runs_organization_idx
  on public.agent_runs (organization_id);
-- 找「被中断、还能续」的运行。恢复流程按这个索引扫
create index if not exists agent_runs_resumable_idx
  on public.agent_runs (status, resumable);

create table if not exists public.agent_steps (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.agent_runs(id) on delete cascade,
  step_index    integer not null,
  -- 上游给的工具调用标识。恢复时靠它判断「这次调用是不是已经做过」——
  -- 靠 step_index 判断不行,模型重新生成时步序可能不同
  tool_call_id  text,
  tool_name     text,
  arguments     jsonb,
  -- 只存摘要,不存全文。一次 git_read_file 可能是几万字符,
  -- 而恢复上下文时本来就要截断(见 agent.ts 的 capToolResult)。
  -- 存全文只会让这张表变成第二个工作区,而且没人会去读它
  result_preview text,
  ok            boolean,
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  -- 同一轮里同一步只能有一行。重复写入是恢复逻辑出错最直接的信号
  unique (run_id, step_index)
);

create index if not exists agent_steps_run_idx
  on public.agent_steps (run_id, step_index);

alter table public.agent_runs  enable row level security;
alter table public.agent_steps enable row level security;

-- 归属跟着对话走 —— 与 conversations_own / messages_own 同一套模型。
-- 用一条 FOR ALL 而不是拆四条:这两张表没有「成员能读、管理员能写」
-- 这类分层,读写都只有对话的主人。拆开只会多三条等价的策略。
create policy agent_runs_own on public.agent_runs
  for all to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = agent_runs.conversation_id
        and c.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = agent_runs.conversation_id
        and c.user_id = (select auth.uid())
    )
  );

create policy agent_steps_own on public.agent_steps
  for all to authenticated
  using (
    exists (
      select 1
      from public.agent_runs r
      join public.conversations c on c.id = r.conversation_id
      where r.id = agent_steps.run_id
        and c.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.agent_runs r
      join public.conversations c on c.id = r.conversation_id
      where r.id = agent_steps.run_id
        and c.user_id = (select auth.uid())
    )
  );

create trigger agent_runs_touch before update on public.agent_runs
  for each row execute function public.touch_updated_at();
