-- =============================================================================
-- 0007 模型的对话能力标记
--
-- 背景:服务商的 /models 返回的是「该账号能访问的全部模型」,不等于
-- 「能用来对话的模型」。以 NVIDIA 为例,100 个模型里有 24 个是向量嵌入、
-- 安全分类、奖励评分、文档解析、图像生成、视频检测、CLIP —— 它们根本不提供
-- /chat/completions 端点。此前导入时不加区分,用户在下拉框选中就是 HTTP 404,
-- 却完全看不出是自己选错了模型类型。
--
-- 两道防线:
--   1. 导入时按用途过滤(src/lib/providers/model-filter.ts,启发式)
--   2. 运行时真实调用失败后自动标记(src/app/api/chat/route.ts)——
--      依据事实而非猜测,这一道才是可靠的
-- 助手页的模型列表只取 chat_unavailable_reason 为空的行。
-- =============================================================================

alter table public.ai_models
  add column if not exists chat_unavailable_reason text;

comment on column public.ai_models.chat_unavailable_reason is
  '非空表示该模型不能用于对话(用途过滤识别,或实际调用失败确认),值为原因。为空表示可用。';

-- 清理此前无差别导入进来的非对话模型。
-- 这里刻意用标记而非删除:标记可追溯、可回退,也不会丢掉「导入过什么」的事实。
update public.ai_models
set chat_unavailable_reason = '该模型不提供对话端点(用途为嵌入/安全分类/解析/图像等),已从可选列表移除'
where chat_unavailable_reason is null
  and (
    model_id ~* '(^|[-/])(nv-)?embed'
    and model_id !~* 'embedded'
    or model_id ~* 'nemoretriever'
    or model_id ~* '(^|[-/])bge([-/]|$)'
    or model_id ~* '(^|[-/])rerank'
    or model_id ~* 'guard'
    or model_id ~* 'content-safety'
    or model_id ~* 'topic-control'
    or model_id ~* '(^|[-/])reward([-/]|$)'
    or model_id ~* '(^|[-/])parse([-/]|$)'
    or model_id ~* 'deplot'
    or model_id ~* 'diffusion'
    or model_id ~* 'video-detector'
    or model_id ~* '(^|[-/])(nv)?clip([-/]|$)'
  );
