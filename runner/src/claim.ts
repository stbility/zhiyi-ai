/**
 * Runner claim —— FOR UPDATE SKIP LOCKED 原子领取(冻结架构 D3 唯一方式)。
 *
 * 领取与 lease 写入必须在同一事务:
 *   BEGIN
 *   → SELECT ... FOR UPDATE SKIP LOCKED(跳过被锁行)
 *   → 写入 claimed_by / claimed_at / lease_expires_at / lease_generation+1
 *   → COMMIT
 *
 * 禁止"先 SELECT 再 UPDATE"两段式(两次往返之间行可能已被抢)。
 *
 * 返回 null = 本轮无任务(回到 poll)。返回 ClaimResult = 领取成功,
 * 调用方必须保存 { run_id, worker_id, lease_generation } 三元组,
 * 后续所有写操作携带该 generation(fence 校验)。
 */

export interface ClaimResult {
  runId: string;
  workerId: string;
  leaseGeneration: number;
  conversationId: string;
  organizationId: string;
  status: "queued" | "interrupted";
  currentStep: number;
  resumable: boolean;
}

export interface ClaimInput {
  /** Runner 实例标识(进程级,hostname+pid+ts) */
  workerId: string;
  /** 租约时长毫秒(默认 90s,Phase 2.2 冻结设计) */
  leaseMs?: number;
  /** 可领取的状态:新任务 queued + 可续 interrupted */
  statuses?: readonly ("queued" | "interrupted")[];
}

const DEFAULT_LEASE_MS = 90_000;

/** 领取:FOR UPDATE SKIP LOCKED 原子事务。pg 是已连接的事务型客户端。 */
export async function claimRun(
  pg: import("pg").PoolClient,
  input: ClaimInput,
): Promise<ClaimResult | null> {
  const statuses = input.statuses ?? (["queued", "interrupted"] as const);
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;

  // 单事务:SELECT FOR UPDATE SKIP LOCKED → UPDATE lease
  // pg 的 query 在同一连接上按序执行,隐式事务块保证原子性;
  // 显式 BEGIN/COMMIT 由调用方持有连接时提供(见 runner.ts)。
  const lockSql = `
    SELECT id, conversation_id, organization_id, status, current_step, resumable
    FROM public.agent_runs
    WHERE status = ANY($1::text[])
      AND (claimed_by IS NULL OR lease_expires_at < now())
    ORDER BY started_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `;
  const lockRes = await pg.query(lockSql, [statuses]);
  if (lockRes.rows.length === 0) {
    return null; // 无任务(或全部被锁)
  }

  const row = lockRes.rows[0];
  const updateSql = `
    UPDATE public.agent_runs
    SET claimed_by = $1,
        claimed_at = now(),
        lease_expires_at = now() + make_interval(secs => $2),
        lease_generation = lease_generation + 1,
        status = 'running',
        updated_at = now()
    WHERE id = $3
    RETURNING lease_generation
  `;
  const updRes = await pg.query(updateSql, [input.workerId, leaseMs / 1000, row.id]);
  if (updRes.rows.length === 0) {
    return null; // 理论上不会(行已锁),防御性返回
  }

  return {
    runId: row.id as string,
    workerId: input.workerId,
    leaseGeneration: updRes.rows[0].lease_generation as number,
    conversationId: row.conversation_id as string,
    organizationId: row.organization_id as string,
    status: row.status as "queued" | "interrupted",
    currentStep: row.current_step as number,
    resumable: row.resumable as boolean,
  };
}
