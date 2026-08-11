-- 0045 MCP 执行日志:Hermes 等外部智能体的执行状态回传
--
-- 背景:Hermes/OpenClaw 通过 /api/mcp(Bearer 令牌)调用智一的
-- workspace_* / git_* 工具,但应用层完全不知道它们在执行什么 ——
-- 「用户在智一购买 → 发起 → 观察 → 收到 PR」缺最后一环(评审建议第 1 项)。
--
-- 本迁移落一张执行日志表:每次 tools/call 由服务端(admin client)记一条,
-- 组织成员在智能体页面看到外部智能体的执行轨迹(工具、时长、结果摘要、
-- PR 链接)。令牌是组织级凭证(可带 created_by),用户归属到令牌创建者,
-- 拿不到就置空 —— 诚实记录已知信息,不编造。
--
-- 写入只走服务端(admin client 绕过 RLS);读取限组织成员
-- (private.is_org_member,与 memories_select_member 同一约定)。

create table if not exists public.mcp_execution_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid references auth.users(id) on delete set null,
  token_id        uuid references public.mcp_access_tokens(id) on delete set null,
  tool_name       text not null,
  -- 脱敏截断后的调用参数(长内容截断,见 src/app/api/mcp/route.ts 的 sanitize)
  args_summary    jsonb,
  -- 结果摘要:git_propose_changes 提取 pull_request_url/branch;其余截断文本
  result_summary  jsonb,
  status          text not null check (status in ('ok', 'error')),
  error           text,
  duration_ms     integer,
  created_at      timestamptz not null default now()
);

create index if not exists mcp_execution_log_org_created_idx
  on public.mcp_execution_log (organization_id, created_at desc);

alter table public.mcp_execution_log enable row level security;

-- 读:组织成员都能看到本组织的执行记录(与 memories_select_member 同约定)
create policy mcp_execution_log_select_member on public.mcp_execution_log
  for select to authenticated
  using (private.is_org_member(organization_id));

-- 写:无任何客户端写策略 —— 服务端 admin client 绕过 RLS 直接插入,
-- 客户端(含成员)永远无法伪造执行记录。
