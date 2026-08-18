-- 0069_platform_free_gpt_oss_120b.sql
-- 2026-08-18
-- 问题:openai/gpt-oss-120b 在 NVIDIA 目录存在,但 platform_models 未注册,
--       用户在平台免费档下拉列表中看不到该模型,无法选择。
-- 修复:按 0053 已有模型(kind=openai_compatible / base_url=NVIDIA)注册该模型,
--       凭证来源与环境变量 PLATFORM_NVIDIA_API_KEY(同 glm-5.2 / gpt-oss-20b)。
--
-- 验证:
--   NVIDIA 目录: openai/gpt-oss-120b 存在于 integrate.api.nvidia.com/v1/models
--   owned_by: openai
--   sort_order: 35(120B 推力介于 fast(30) 与 slow glm-5.2(40) 之间)

insert into public.platform_models
  (kind, base_url, model_id, display_name, api_key_env, tier, sort_order)
values
  (
    'openai_compatible',
    'https://integrate.api.nvidia.com/v1',
    'openai/gpt-oss-120b',
    'GPT-OSS 120B(免费)',
    'PLATFORM_NVIDIA_API_KEY',
    'free',
    35
  )
on conflict (kind, base_url, model_id) do nothing;
