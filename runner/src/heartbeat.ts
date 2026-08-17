/**
 * Runner heartbeat —— 租约续期(Phase 2.2 §5)。
 *
 * 每 60 秒续租一次,租约 90 秒(留 30s 容差)。
 * 心跳必须携带 { run_id, worker_id, lease_generation } 三元组:
 *   · 0 行 = 已被接管(generation 变了)/ 已 terminal / 被 cancel
 *     → 调用方必须停止执行(AbortController.abort + 退出执行循环)
 */

export interface HeartbeatInput {
  pg: import("pg").PoolClient;
  runId: string;
  workerId: string;
  leaseGeneration: number;
  /** 续租到的时长毫秒(默认与 claim 一致 90s) */
  leaseMs?: number;
}

export async function renewLease(input: HeartbeatInput): Promise<boolean> {
  const leaseMs = input.leaseMs ?? 90_000;
  const res = await input.pg.query(
    `
    UPDATE public.agent_runs
    SET lease_expires_at = now() + make_interval(secs => $1),
        updated_at = now()
    WHERE id = $2
      AND claimed_by = $3
      AND lease_generation = $4
      AND status NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
    RETURNING id
    `,
    [leaseMs / 1000, input.runId, input.workerId, input.leaseGeneration],
  );
  return res.rows.length > 0; // false = fence lost / terminal → 停止执行
}
