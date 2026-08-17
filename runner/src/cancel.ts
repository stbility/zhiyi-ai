/**
 * Runner cancel(阶段 F,Phase 2.2 §11)。
 *
 * 原则:
 *   - cancel 是管理操作(不要求持有 generation —— 任何时刻用户可取消)
 *   - cancel 生效 = 置 status='cancelled' + generation+1(强制失效当前 Runner)
 *   - 与 finish 竞争:行锁 + WHERE 条件原子解决,terminal 状态不可被改写
 *   - 不假设 session/cancel ACK = Agent 已完全停止(实证:turn_complete
 *     事件不可靠)→ 最终判定用 DB 状态(fence 校验)
 */

export interface CancelRunInput {
  client: import("pg").PoolClient;
  runId: string;
  /** 若同时要中断 Hermes 会话,传 acpSessionId(可选,Runner 侧调用) */
  acpSessionId?: string;
}

/**
 * 取消 run(幂等):
 *   - 非 terminal → status='cancelled' + lease_generation+1 + 清 lease
 *   - 已 terminal → 0 行(no-op,幂等)
 * 返回 true = 本次生效(从非 terminal 转为 cancelled);false = 已是 terminal。
 */
export async function cancelRun(input: CancelRunInput): Promise<boolean> {
  const res = await input.client.query(
    `
    UPDATE public.agent_runs
    SET status = 'cancelled',
        completed_at = now(),
        lease_generation = lease_generation + 1,  -- 强制失效当前 Runner
        claimed_by = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = $1
      AND status NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
    RETURNING id
    `,
    [input.runId],
  );
  return res.rows.length > 0;
}

/**
 * Zombie 扫描(Cron 专用,只做标记不执行 Agent):
 *   - running 但 lease 过期 → interrupted(有步骤)或 failed(无步骤)
 * 返回处理的行数。
 */
export async function recoverExpiredLeases(
  client: import("pg").PoolClient,
): Promise<{ interrupted: number; failed: number }> {
  // 有步骤的 running + lease 过期 → interrupted(resumable)
  const interruptedRes = await client.query(
    `
    UPDATE public.agent_runs
    SET status = 'interrupted',
        resumable = true,
        lease_generation = lease_generation + 1,
        claimed_by = NULL,
        lease_expires_at = NULL,
        error_message = 'Runner 中断:租约过期,可由用户继续',
        updated_at = now()
    WHERE status IN ('running', 'waiting_model', 'running_tool')
      AND lease_expires_at < now()
      AND current_step > 0
    RETURNING id
    `,
  );

  // 无步骤的 running + lease 过期 → failed(无检查点)
  const failedRes = await client.query(
    `
    UPDATE public.agent_runs
    SET status = 'failed',
        resumable = false,
        lease_generation = lease_generation + 1,
        claimed_by = NULL,
        lease_expires_at = NULL,
        error_message = 'Runner 中断且无检查点',
        completed_at = now(),
        updated_at = now()
    WHERE status IN ('running', 'waiting_model', 'running_tool')
      AND lease_expires_at < now()
      AND current_step = 0
    RETURNING id
    `,
  );

  return {
    interrupted: interruptedRes.rows.length,
    failed: failedRes.rows.length,
  };
}
