-- 0058 platform_models 排序修正(2026-08-12)
--
-- 背景:免费档默认模型 = sort_order 第一个(前端 models[0])。
-- glm-5.2 生产实测首 token 70-120 秒(NVIDIA 容量塌陷,见 0053 备注),
-- 与 minimax-m3(≈4s)/gpt-oss-20b(即时)同挂 sort_order 30,
-- 稳定排序下可能排到快模型前面 —— 用户默认选中慢模型,
-- 撞 45s 单步超时 → 「输出慢、模式不稳定」。
--
-- 修复:glm-5.2 降到 sort_order 40(排在两个快模型之后),
-- 永不成为默认选择;保留不删(用户 2026-08-11 点名长期免费)。

update public.platform_models
set sort_order = 40
where kind = 'openai_compatible'
  and base_url = 'https://integrate.api.nvidia.com/v1'
  and model_id = 'z-ai/glm-5.2'
  and sort_order = 30;
