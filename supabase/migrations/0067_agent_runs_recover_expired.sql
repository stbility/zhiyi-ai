-- 0067 Agent Runner 过期租约恢复 RPC(Cron 扫描器专用)
--
-- 【要解决的真实问题】
-- Runner 崩溃后 lease 过期,需要外部机制把 zombie run 置为可恢复状态:
--   · 有步骤(agent_steps 存在)→ interrupted(resumable=true,用户可继续)
--   · 无步骤 → failed(无检查点,如实标注)
--
-- 【为什么是 RPC】
-- service role 客户端(supabase-js)无法表达 `lease_generation = lease_generation + 1`
-- 这类原生 SQL 表达式;恢复逻辑需要原子 UPDATE + 计数返回,放函数体内最干净。
-- Cron 扫描器(GET /api/agent/runner/scan)调用它,只做秒级标记,不执行 Agent。
--
-- 【幂等(必须满足)】
--   1. 每个 UPDATE 的 WHERE 都含 `lease_expires_at < now()`:
--      已恢复的行 lease_expires_at 置 NULL → NULL < now() 为 UNKNOWN(不命中)
--      → 重复调用不会二次处理同一行。
--   2. 状态转换后 status 离开 ('running','waiting_model','running_tool'):
--      第二个并发调用(双 Cron 同刻触发)WHERE status IN (...) 不命中
--      → 同一行最多被处理一次。
--   3. 无 UPDATE 副作用时返回计数 0,可安全重复调用。
--
-- 【最小权限(必须满足)】
--   security definer + set search_path='' + 显式 revoke public:
--   - 默认 PostgreSQL 函数 EXECUTE 授予 PUBLIC —— 必须收回,
--     只授予 service_role(Cron 扫描器经 admin client 调用)。
--   - 函数体只触碰 public.agent_runs 的 lease 过期行,不写其他表。
--
-- 【事务性】
--   PL/pgSQL 函数体在单个事务内执行:两条 UPDATE 原子提交,
--   generation+1 与状态转换在同一事务完成,不存在半完成状态。
--   失败任一条 → 整体回滚(包括已完成的 generation+1)。
--
-- 【冻结边界】只处理「真正过期的 lease」:
--   status IN (running/waiting_model/running_tool) AND lease_expires_at < now()。
--   不碰 queued(claim 目标,Runner 正常领取路径)、不碰 /api/agent、
--   不碰 P1 / Workflow / usage 语义。

create or replace function public.recover_expired_agent_runs()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_interrupted integer := 0;
  v_failed integer := 0;
begin
  -- 有步骤 + lease 过期 → interrupted(resumable,用户可继续)
  -- 幂等:已恢复行 lease_expires_at=NULL 不再命中;generation+1 防旧 Runner 写入
  with upd as (
    update public.agent_runs
    set status = 'interrupted',
        resumable = true,
        lease_generation = lease_generation + 1,
        claimed_by = null,
        lease_expires_at = null,
        error_message = 'Runner 中断:租约过期,可由用户继续',
        updated_at = now()
    where status in ('running','waiting_model','running_tool')
      and lease_expires_at < now()
      and current_step > 0
    returning id
  )
  select count(*) into v_interrupted from upd;

  -- 无步骤 + lease 过期 → failed(无检查点)
  with upd2 as (
    update public.agent_runs
    set status = 'failed',
        resumable = false,
        lease_generation = lease_generation + 1,
        claimed_by = null,
        lease_expires_at = null,
        error_message = 'Runner 中断且无检查点',
        completed_at = now(),
        updated_at = now()
    where status in ('running','waiting_model','running_tool')
      and lease_expires_at < now()
      and current_step = 0
    returning id
  )
  select count(*) into v_failed from upd2;

  return jsonb_build_object('interrupted', v_interrupted, 'failed', v_failed);
end;
$$;

-- 最小权限:收回 PUBLIC 默认 EXECUTE,只授予 service_role(Cron 扫描器)
revoke all on function public.recover_expired_agent_runs() from public;
grant execute on function public.recover_expired_agent_runs() to service_role;
