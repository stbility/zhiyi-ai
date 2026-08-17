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
-- 【与 Runner 内 recoverExpiredLeases 语义一致】同一套状态转换规则,
-- 双入口(Runner 进程内定时 + Cron 兜底)不产生行为分叉。
--
-- 【安全】security definer + set search_path='' + 只更新 lease 过期行,
-- 不触碰其他行;返回值仅计数。

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
