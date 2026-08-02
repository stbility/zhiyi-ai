-- 0019 Git 仓库安装记录(GitHub App)
--
-- 为什么不复用 integrations 表:两者的凭据模型根本不同。
--
--   integrations 存的是**长期有效的密钥**(Tavily 的 API Key),加密后落库,
--   用的时候解开直接发。
--
--   GitHub App 存的是**安装 id**。它本身不是凭据,泄露了也调不动任何接口 ——
--   真正的凭据是用 App 私钥当场签一个 JWT、再拿 JWT 换一个只活 1 小时的
--   安装令牌。私钥在服务端环境变量里,永远不进数据库。
--
-- 这个差别很重要:整张表**没有任何需要加密的列**。把安装 id 塞进
-- credential_cipher 会造成「这是个密钥」的错觉,反而让人放松对私钥的看管。
--
-- 参考:https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app

create table if not exists public.git_installations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- 目前只有 github,留字段是为了以后接 GitLab / Gitee 时不用改表
  provider        text not null default 'github',
  -- GitHub 侧的安装 id。换取安装令牌时要用
  installation_id text not null,
  -- 安装到哪个账号/组织下,纯展示用,让用户认得出是哪个
  account_login   text,
  -- 授权范围:'all' 或 'selected'。用户在 GitHub 界面上选的,我们只记录
  repository_selection text,
  connected_by    uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- 一个组织在同一个 Git 服务商下只保留一份安装记录,重连即覆盖
  unique (organization_id, provider)
);

create index if not exists git_installations_organization_idx
  on public.git_installations (organization_id);
create index if not exists git_installations_connected_by_idx
  on public.git_installations (connected_by);

alter table public.git_installations enable row level security;

-- 读:成员都能看到「连了哪个仓库账号」—— 否则界面上无法解释代码从哪来
create policy git_installations_select_member on public.git_installations
  for select to authenticated
  using (private.is_org_member(organization_id));

-- 写:只有 owner / admin。连接与断开是管理决定,而且直接影响代码可见范围
create policy git_installations_insert_admin on public.git_installations
  for insert to authenticated
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

create policy git_installations_update_admin on public.git_installations
  for update to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]))
  with check (private.has_org_role(organization_id, array['owner','admin']::org_role[]));

create policy git_installations_delete_admin on public.git_installations
  for delete to authenticated
  using (private.has_org_role(organization_id, array['owner','admin']::org_role[]));
