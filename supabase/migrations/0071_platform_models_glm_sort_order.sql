-- 0071 platform_models glm-5.2 排序修正(2026-08-19)
--
-- 背景:0058 想修「glm-5.2 首 token 70-120s(NVIDIA 容量塌陷)排到快模型
-- 之后,永不成为默认选择」,但 UPDATE 条件写的是 `sort_order = 30`,
-- 而 0053 实际把 glm-5.2 设成了 sort_order = 10 —— 条件永不命中,
-- 0058 在生产 0 行生效(执行成功但目的未达,账本已入)。
--
-- 本迁移不改 0058(历史已入账),用无条件匹配 model_id 的方式落地目标值:
--   sort_order = 40,排在 minimax-m3(20)/ gpt-oss-20b(30)/ gpt-oss-120b(35)
--   之后,永不成为 models[0] 默认候选。
--
-- 幂等:`and sort_order <> 40` 保证重复执行第二次 0 行,结果稳定。

update public.platform_models
set sort_order = 40
where kind = 'openai_compatible'
  and base_url = 'https://integrate.api.nvidia.com/v1'
  and model_id = 'z-ai/glm-5.2'
  and sort_order <> 40;
