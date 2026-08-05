-- 0028 工具结果的截断事实与执行耗时
--
-- 【用户实测的两个问题,同一个根子】
-- ① 界面把工具结果静默截断到 300 字符,**没有任何截断标记** ——
--    用户看到 README 只显示一段,合理地以为「读取中断了」。
--    实际上智能体收到的是完整内容(上限 30,000 字符)。
--    截断本身没错(整篇 README 铺在对话里毫无意义),
--    错的是**不说**。不说就等于让用户自己去猜,而他猜错了。
--
-- ② 落库时也只存了摘要,没存「原文多长」。于是事后连
--    「到底读到了多少」都无法回答 —— 摘要是 300 字这个事实,
--    既不能证明读成功了,也不能证明没读成功。
--
-- 记录事实,而不是记录我们展示了什么。
alter table public.agent_steps
  add column if not exists result_chars integer,
  add column if not exists preview_chars integer,
  add column if not exists truncated boolean not null default false,
  add column if not exists duration_ms integer;

comment on column public.agent_steps.result_chars is
  '工具返回的完整字符数。界面只展示摘要,不记这个数就无法回答「到底读到了多少」';
comment on column public.agent_steps.preview_chars is
  '实际存进 result_preview 的字符数';
comment on column public.agent_steps.truncated is
  '展示内容是否被截断。用户曾把 300 字的摘要误认为「读取中断」';
comment on column public.agent_steps.duration_ms is
  '这次工具执行的耗时。定位「慢在哪一环」时,工具执行必须与模型生成分开';
