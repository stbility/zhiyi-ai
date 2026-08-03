-- =============================================================================
-- 0022 MCP 访问令牌
--
-- 智一 AI 要把「工作流资产」变成任何运行时都能消费的东西 —— 用户买的是资产,
-- 不是一个网页。所以对外开一个 MCP Server,让 OpenClaw、Hermes Agent
-- 以及任何支持 MCP 的客户端都能接进来。
--
-- 这是本系统**第一个面向公网、不走浏览器会话**的入口,所以令牌模型要一次做对:
--
-- 1. **只存哈希,不存令牌本身。**
--    令牌是 bearer 凭据:拿到就能用。它和 AI 服务商密钥不同 ——
--    那些必须能解密后原样发给上游,所以用 AES-256-GCM 可逆加密;
--    而这个我们只需要「验证是不是它」,永远不需要还原。存哈希意味着
--    即使数据库被拖走,里面的令牌也用不了。
--    令牌是 32 字节随机数(高熵),SHA-256 足够;不需要 bcrypt 那类
--    慢哈希 —— 那是给低熵口令防暴力破解用的。
--
-- 2. **哈希列不对 authenticated 开放。**
--    与迁移 0018 同样的理由:PostgREST 是对外暴露的,任何成员拿着自己的
--    会话令牌就能 GET 出整列。验证只在服务端走 service_role。
--
-- 3. **可撤销,不可修改。**
--    只留 revoked_at,不提供「改令牌」——改等于换一个新的,那就该新建一条,
--    旧的留着作为审计痕迹。
-- =============================================================================

create table if not exists public.mcp_access_tokens (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- 用户给的名字,用来分辨这把是给谁的:「OpenClaw 生产」「Hermes 定时」
  name            text not null check (length(btrim(name)) between 1 and 60),
  -- sha256(令牌明文) 的十六进制。唯一索引顺带保证同一把令牌不会被登记两次
  token_hash      text not null unique,
  -- 前若干位,界面上用来认出是哪一把。不构成泄露:剩余熵仍然足够
  token_prefix    text not null,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  -- 最后一次成功使用。用来发现「这把还在用吗」,以及排查是谁在调
  last_used_at    timestamptz,
  -- 撤销即失效。不删行 —— 删掉就查不出「这把曾经存在过」
  revoked_at      timestamptz
);

create index if not exists mcp_access_tokens_organization_idx
  on public.mcp_access_tokens (organization_id);
create index if not exists mcp_access_tokens_created_by_idx
  on public.mcp_access_tokens (created_by);

alter table public.mcp_access_tokens enable row level security;

-- 读:成员都能看到「这个组织开了哪几把令牌」——否则界面上无法解释
-- 是谁在通过 MCP 访问工作区
create policy mcp_access_tokens_select_member on public.mcp_access_tokens
  for select to authenticated
  using (private.is_org_member(organization_id));

-- 写:只有 owner / admin。开一把 MCP 令牌等于开放整个组织的工作区读写,
-- 这是管理决定,不是每个成员都能做的
create policy mcp_access_tokens_insert_admin on public.mcp_access_tokens
  for insert to authenticated
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

create policy mcp_access_tokens_update_admin on public.mcp_access_tokens
  for update to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]))
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

create policy mcp_access_tokens_delete_admin on public.mcp_access_tokens
  for delete to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

-- 哈希列不对浏览器开放。
--
-- 注意顺序:**列级 REVOKE 撤不掉表级授权**(迁移 0018 踩过这个坑,
-- 只写 revoke select (col) 语句会成功但完全不起作用)。
-- 必须先收回表级 SELECT,再按列白名单重新授予。
revoke select on public.mcp_access_tokens from authenticated, anon;

grant select (
  id, organization_id, name, token_prefix,
  created_by, created_at, last_used_at, revoked_at
) on public.mcp_access_tokens to authenticated;

comment on column public.mcp_access_tokens.token_hash is
  'sha256(令牌明文) 十六进制。只用于验证,永不还原;不对 authenticated 开放读取。';
