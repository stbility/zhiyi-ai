-- 0030 MCP Server 注册表
--
-- 智一智能体从「只能调自己的工具」升级到「能调外部 MCP 生态」。
-- 这是产品独立于 Hermes 的第一步:外部 MCP server 在这里登记,
-- agent 运行时按 org 拉取启用的 server,把它们的工具动态注入工具循环。
--
-- 为什么是独立一张表而不是塞进 integrations:
--   integrations 是「凭据 + 连接验证」的通用集合(Tavily、GitHub…),
--   而 mcp_servers 除了凭据还有**协议语义**:
--     · name 会成为工具名前缀 (mcp__<name>__<tool>),必须唯一且是合法 slug
--     · url 是 MCP 端点,有 https 强制
--     · timeout 是每次调用的预算,直接决定 agent 步骤会不会烧穿 Vercel 时限
--   混进 integrations,这些字段会污染那张表的通用性。
--
-- 安全模型(与 0022 MCP tokens 同构):
--   读:组织成员可见(不含密文列)
--   写:owner / admin —— 登记一个外部 server 等于向 agent 开放一条出网通道,
--      这是管理决定。
--   密文:AES-256-GCM 加密落库,界面只显示掩码 —— 与 integrations 同模式。
--   明文只在发起 tools/call 的瞬间存在于内存,永不落日志。
--
-- 【纯新增】不改任何现有表、策略、授权。与 0028/0029 同类,风险最低的一档。

create table if not exists public.mcp_servers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- 工具名前缀用。slug 校验放在应用层;这里只保证唯一
  name            text not null,
  -- MCP 端点。https 强制,http 只允许 localhost(应用层校验,见 client.ts)
  url             text not null,
  -- 凭据。与 integrations 同模式:AES-256-GCM 密文 + 界面掩码
  auth_token_cipher text not null,
  auth_token_masked text not null,
  enabled         boolean not null default true,
  -- 单次调用的超时。外部 server 可能很慢,但 agent 的预算有限 ——
  -- 默认 15s,宁可失败也不要烧穿 Vercel 300s 上限
  timeout_ms      integer not null default 15000
    check (timeout_ms >= 1000 and timeout_ms <= 60000),
  -- 连接验证状态(界面「测试连接」按钮用)。测试失败不自动禁用 ——
  -- 失败原因要给人看,让人决定是修还是停
  last_tested_at  timestamptz,
  last_test_ok    boolean,
  last_test_error text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name)
);

create index if not exists mcp_servers_organization_idx
  on public.mcp_servers (organization_id);
create index if not exists mcp_servers_created_by_idx
  on public.mcp_servers (created_by);

alter table public.mcp_servers enable row level security;

-- 读:组织成员都能看到(不含密文列 —— 见下方列级 revoke)
create policy mcp_servers_select_member on public.mcp_servers
  for select to authenticated
  using (private.is_org_member(organization_id));

-- 写:只有 owner / admin。登记外部 server = 开放出网通道,是管理决定
create policy mcp_servers_insert_admin on public.mcp_servers
  for insert to authenticated
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

create policy mcp_servers_update_admin on public.mcp_servers
  for update to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]))
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

create policy mcp_servers_delete_admin on public.mcp_servers
  for delete to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

-- 密文列不对浏览器开放。注意顺序(迁移 0018 的坑):
-- 列级 REVOKE 撤不掉表级授权,必须先收回表级 SELECT,再按列白名单重新授予
revoke select on public.mcp_servers from authenticated, anon;

grant select (
  id, organization_id, name, url, auth_token_masked,
  enabled, timeout_ms, last_tested_at, last_test_ok, last_test_error,
  created_by, created_at, updated_at
) on public.mcp_servers to authenticated;

comment on table public.mcp_servers is
  '外部 MCP server 注册表。agent 按 org 拉取启用的 server,动态注入工具循环';
comment on column public.mcp_servers.auth_token_cipher is
  'Bearer 令牌的 AES-256-GCM 密文。明文只在 tools/call 瞬间存在';
comment on column public.mcp_servers.auth_token_masked is
  '界面展示用的掩码(如 Bearer sk-abc…)。不构成泄露';
