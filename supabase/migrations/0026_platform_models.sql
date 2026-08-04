-- 0026 平台免费模型池 + 免费档隔离
--
-- 【要解决的问题】
-- 新用户注册后有了组织,但组织下**一个模型都没有** —— 助手页是空的,
-- 什么都做不了。「注册完直接能对话」这条从来没有成立过。
--
-- 【为什么不复用 ai_providers / ai_models】
-- 那两张表是**按组织**存的(organization_id NOT NULL),存的是用户自己的
-- BYOK 密钥(api_key_cipher NOT NULL)。要让它们承载平台级的共享模型,
-- 就得把这两列改成可空 —— 而这两列正是 RLS 策略和列级 GRANT 的依据,
-- 改了要重写全部策略,爆炸半径远大于收益。
--
-- 所以平台目录单独一张表。它和用户的 BYOK 是两件事:
--   ai_providers/ai_models  用户自己的密钥,他自己管,想删就删
--   platform_models         平台提供的,所有组织共享,用户改不了
--
-- 【密钥不在这张表里】
-- 只存**环境变量的名字**(api_key_env),真实密钥永远在部署环境里。
-- 这样:密钥不进代码库、不进数据库、不下发浏览器,轮换只需改环境变量。
-- 环境变量没配时该模型不出现,界面如实显示「未配置」—— 不伪装成已接通。

-- 免费档隔离开关。
--
-- 默认 true:新组织一律先进免费档。反过来(默认 false)的话,
-- 任何一次漏写都会让新组织直接拿到付费模型 —— 默认值要选**出错时代价小**的那个。
alter table public.organizations
  add column if not exists free_only boolean not null default true;

comment on column public.organizations.free_only is
  '仅限免费档。true 时候选池不含 tier=paid 的平台模型;不影响用户自己的 BYOK 模型';

create table if not exists public.platform_models (
  id            uuid primary key default gen_random_uuid(),
  -- 与 ai_providers.kind 同一套取值,走同一个适配器
  kind          text not null,
  base_url      text,
  model_id      text not null,
  display_name  text not null,
  -- 密钥所在的环境变量名。真实密钥永远不进这张表
  api_key_env   text not null,
  -- free 的所有组织都能用;paid 只有非 free_only 的组织能用
  tier          text not null check (tier in ('free', 'paid')),
  enabled       boolean not null default true,
  -- 展示顺序。数字小的排前面
  sort_order    integer not null default 100,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (kind, base_url, model_id)
);

create index if not exists platform_models_tier_idx
  on public.platform_models (tier, enabled);

alter table public.platform_models enable row level security;

-- 读:所有登录用户都能看到目录。
-- 这张表里没有任何机密 —— 密钥只存了**变量名**,而变量名本身不是秘密
-- (它就写在部署文档里)。看得到目录,用户才能理解「免费档有哪些模型」。
create policy platform_models_select_authenticated on public.platform_models
  for select to authenticated
  using (enabled);

-- 写:**没有任何策略**。
-- 平台目录由迁移维护,不由用户改 —— 少写一条 insert 策略,
-- 就少一条「用户把自己的模型塞进平台池」的路。
-- 需要改的时候走迁移或 service_role,那是有审计的路径。

-- 种子:只放**已经在生产上验证跑通**的模型。
--
-- 这三个是用户从英伟达 102 个模型里亲手筛出来的(其余的要么是嵌入模型、
-- 要么是安全护栏模型、要么调不通)。不凭名字猜哪个能用 ——
-- 早先那次凭名字筛,误删了 kimi-k2.6 这样的好模型。
--
-- api_key_env 指向 PLATFORM_NVIDIA_API_KEY:这是**平台自己的**密钥,
-- 与任何用户的 BYOK 无关。没配置时这三个模型不会出现在任何组织的候选里,
-- 界面如实显示未配置。
insert into public.platform_models
  (kind, base_url, model_id, display_name, api_key_env, tier, sort_order)
values
  ('openai_compatible', 'https://integrate.api.nvidia.com/v1',
   'deepseek-ai/deepseek-v4-flash', 'DeepSeek V4 Flash(免费)',
   'PLATFORM_NVIDIA_API_KEY', 'free', 10),
  ('openai_compatible', 'https://integrate.api.nvidia.com/v1',
   'deepseek-ai/deepseek-v4-pro', 'DeepSeek V4 Pro(免费)',
   'PLATFORM_NVIDIA_API_KEY', 'free', 20),
  ('openai_compatible', 'https://integrate.api.nvidia.com/v1',
   'z-ai/glm-5.2', 'GLM 5.2(免费)',
   'PLATFORM_NVIDIA_API_KEY', 'free', 30)
on conflict (kind, base_url, model_id) do nothing;
