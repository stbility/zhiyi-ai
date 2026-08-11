-- 0052_platform_models_refresh.sql
-- 平台免费档模型池刷新(2026-08-11 生产实测)。
--
-- 【要解决的问题】智能体/AI助手两个页面模型「不能正常工作、输出非常慢、
-- 300 秒中断、内容丢失」。生产实测根因(NVIDIA integrate API 直测):
--   · deepseek-ai/deepseek-v4-flash → HTTP 410 Gone
--     「reached its end of life on 2026-08-07」—— 模型已下线
--   · deepseek-ai/deepseek-v4-pro   → 同上,410 Gone
--   · z-ai/glm-5.2                  → 可用,但首 token 70-120 秒(容量塌陷)
-- 0026 种子的 3 个免费模型里 2 个已死、1 个慢到撞 Vercel 300s 上限,
-- 两个页面要么报错要么超时,产物随中断丢失 —— 免费档等于不可用。
--
-- 【修复】免费档模型池刷新:
--   · 下线已 EOL 的 deepseek-v4-flash / deepseek-v4-pro(enabled=false,
--     不删行 —— 生产账本与历史留痕,新用户也不再看到它们)
--   · 保留 z-ai/glm-5.2(用户 2026-08-11 点名作为长期免费模型)
--   · 加入生产实测可用的快模型:
--       minimaxai/minimax-m3   首 token ≈4s
--       openai/gpt-oss-20b     即时
--     让免费档降级链真正跨模型可用,不再被单点容量塌陷打死。
--   · 全部幂等:UPDATE 按 model_id 匹配,INSERT 走 on conflict do nothing,
--     全新重放库与生产库(0026 已应用)重跑都安全。
--
-- 密钥仍然只存环境变量名,不进本表;PLATFORM_NVIDIA_API_KEY 未配置时
-- 这些模型照旧不出现(界面如实显示「未配置」)。

-- 1) 下线已 EOL 的模型(0026 种子的两个 deepseek-v4,2026-08-07 下线)
update public.platform_models
   set enabled = false
 where model_id in ('deepseek-ai/deepseek-v4-flash', 'deepseek-ai/deepseek-v4-pro');

-- 2) 确保用户点名的长期免费模型在位且启用(0026 已种,此句幂等兜底)
update public.platform_models
   set enabled = true,
       sort_order = 10
 where model_id = 'z-ai/glm-5.2';

-- 3) 加入生产实测可用的快模型(免费档降级链的活路)
insert into public.platform_models
  (kind, base_url, model_id, display_name, api_key_env, tier, sort_order)
values
  ('openai_compatible', 'https://integrate.api.nvidia.com/v1',
   'minimaxai/minimax-m3', 'MiniMax M3(免费)',
   'PLATFORM_NVIDIA_API_KEY', 'free', 20),
  ('openai_compatible', 'https://integrate.api.nvidia.com/v1',
   'openai/gpt-oss-20b', 'GPT-OSS 20B(免费)',
   'PLATFORM_NVIDIA_API_KEY', 'free', 30)
on conflict (kind, base_url, model_id) do nothing;
