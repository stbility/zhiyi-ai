-- 0066 Agent Runner ACP session 映射(阶段 E:恢复/续跑数据基础)
--
-- 【要解决的真实问题】
-- Runner 中断后,新 Runner 接管 interrupted run 时,必须恢复**同一** Hermes
-- ACP 会话(session/resume)而不是新建 —— 否则 Agent Continuation 丢失,
-- 等价于创建了新的逻辑执行(违反"同一个 run_id → 同一逻辑执行"冻结原则)。
-- 为此需要在 agent_runs 上持久化 ACP 会话身份。
--
-- 【纯新增】两列可空,不改任何现有列/约束/语义:
--   acp_session_id    Hermes ACP 会话 id(session/new 返回的 session_id)
--   hermes_session_id Hermes 内部会话 id(sessionProvenance.currentHermesSessionId)
--
-- 【写入时机】
--   · claim 成功后 createSession → 立即写这两列(claim 事务内或紧接)
--   · interrupted resume claim → 读 acp_session_id → session/resume
--   · 完成/失败/取消 → 置 NULL(会话不再需要)
--
-- 【幂等】add column if not exists,重放安全。

begin;

alter table public.agent_runs
  add column if not exists acp_session_id text,
  add column if not exists hermes_session_id text;

commit;
