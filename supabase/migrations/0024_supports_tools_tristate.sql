-- supports_tools 改成三态:未知 / 支持 / 不支持。
--
-- 这一列在迁移 0004 里被定义成 `boolean not null default false`,
-- 然后**从来没有被写过,也从来没有被读过** —— 全项目零引用。
--
-- 它之所以是死数据,根子就在这个定义上:not null default false 把
-- 「还没测过」和「测过,不支持」压成了同一个值 false。于是 false
-- 什么也不代表 —— 拿它去挡用户,会把一堆其实好好的模型挡在门外;
-- 拿它去放行,又等于没有这一列。既然读了没用,自然就没人读。
--
-- 三态之后每个值都有确切含义:
--   null   还没有观察到任何证据。**不拦**,照常让用户用。
--   true   亲眼见过这个模型发出 tool_calls。这是唯一算数的正面证据。
--   false  服务商明确拒绝了 tools 参数(HTTP 400 之类)。
--
-- 特别注意 false 的判据:**模型收到工具却用散文作答,不算不支持**。
-- 它可能只是觉得这道题不需要动工具。把「没调」当成「不能调」,
-- 就会把模型永久拉黑,而它下一次可能好好地调了。
-- 只有服务商自己说「我不接受这个参数」才算数。
alter table public.ai_models
  alter column supports_tools drop not null,
  alter column supports_tools drop default;

-- 现存的 false 全部归零。
--
-- 它们不是测出来的 —— 这一列从来没被写过,所有 false 都只是
-- 建表时的默认值。把它们留着当「不支持」,就是拿一个从未发生过的
-- 观察去挡用户。
update public.ai_models set supports_tools = null where supports_tools = false;

-- 观察时间。用来判断这条结论是不是过期了 ——
-- 服务商随时可能给某个模型开启工具支持。
alter table public.ai_models
  add column if not exists tools_checked_at timestamptz;

comment on column public.ai_models.supports_tools is
  '工具调用能力,三态:null = 未观察到证据(不拦);true = 亲眼见过它发出 tool_calls;false = 服务商明确拒绝了 tools 参数。模型收到工具却用散文作答不算 false。';
comment on column public.ai_models.tools_checked_at is
  '最后一次观察到工具能力证据的时间。服务商随时可能开启支持,结论会过期。';
