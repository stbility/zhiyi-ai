-- =============================================================================
-- 0009 模型的「上次失败原因」与「不再自动剔除」
--
-- 策略变更:系统不再自动把模型从可选列表里拿走。
--
-- 之前是「永久性失败即标记 chat_unavailable_reason」,想让用户知道为什么某个
-- 模型不见了。但实际后果是把用户真正需要的模型悄悄拿走 —— moonshotai/kimi-k2.6
-- 就是这种情况:服务商目录里有、代理编程要用,只是这个账号暂时没被授权,
-- 而系统替用户判了死刑。
--
-- 现在:失败只记录在 last_error,模型仍然可选;真的调不通时由跨厂商降级链
-- 换一个模型完成任务,工作流不中断。去留交给用户按删除键决定。
-- =============================================================================

alter table public.ai_models
  add column if not exists last_error text;

comment on column public.ai_models.last_error is
  '上次调用失败的原因(含服务商原话)。仅作留痕,不影响该模型是否可选。';

comment on column public.ai_models.chat_unavailable_reason is
  '非空表示用户或导入流程判定其不可用于对话。系统不会自动写入此列 —— 自动剔除会把用户需要的模型悄悄拿走。';

update public.ai_models
set last_error = chat_unavailable_reason,
    chat_unavailable_reason = null
where chat_unavailable_reason is not null;
