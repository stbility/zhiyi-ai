/**
 * Runner fencing —— generation 写保护(Phase 2.2 §4/§8)。
 *
 * 所有关键写操作(agent_steps 插入 / checkpoint / finish / 状态更新)
 * 必须携带 { run_id, lease_generation }:
 *   · agent_steps INSERT:INSERT...SELECT 原子校验当前 generation + lease 有效
 *   · checkpoint/状态:UPDATE WHERE lease_generation = :gen
 *   · 0 行 = fence lost → 调用方立即 AbortController.abort() + 退出执行
 */

export interface FenceContext {
  pg: import("pg").PoolClient;
  runId: string;
  leaseGeneration: number;
}

/**
 * 原子插入 agent_step,仅在"当前 generation 且 lease 有效"时成功。
 * 返回 true = 插入成功;false = fence lost(调用方必须停止执行)。
 */
export async function insertStepFenced(
  ctx: FenceContext,
  step: {
    stepIndex: number;
    toolCallId: string | null;
    toolName: string | null;
    arguments: unknown;
    resultPreview: string;
    resultChars: number;
    previewChars: number;
    truncated: boolean;
    durationMs: number | null;
    ok: boolean;
  },
): Promise<boolean> {
  const res = await ctx.pg.query(
    `
    INSERT INTO public.agent_steps
      (run_id, step_index, tool_call_id, tool_name, arguments,
       result_preview, result_chars, preview_chars, truncated,
       duration_ms, ok, completed_at)
    SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now()
    FROM public.agent_runs
    WHERE agent_runs.id = $1
      AND agent_runs.lease_generation = $12
      AND agent_runs.lease_expires_at > now()
    RETURNING id
    `,
    [
      ctx.runId,
      step.stepIndex,
      step.toolCallId,
      step.toolName,
      step.arguments,
      step.resultPreview,
      step.resultChars,
      step.previewChars,
      step.truncated,
      step.durationMs,
      step.ok,
      ctx.leaseGeneration,
    ],
  );
  return res.rows.length > 0;
}

/** 更新 checkpoint(current_step),仅当前 generation 可写。返回 true=成功。 */
export async function updateCheckpointFenced(
  ctx: FenceContext,
  stepIndex: number,
): Promise<boolean> {
  const res = await ctx.pg.query(
    `
    UPDATE public.agent_runs
    SET current_step = $2, updated_at = now()
    WHERE id = $1
      AND lease_generation = $3
      AND status NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
    RETURNING id
    `,
    [ctx.runId, stepIndex, ctx.leaseGeneration],
  );
  return res.rows.length > 0;
}

/** finish(CAS):仅持有者 + 当前 generation + 非 terminal 可 finalize。返回 true=成功。 */
export async function finishFenced(
  ctx: FenceContext,
  workerId: string,
  outcome: "completed" | "failed" | "interrupted",
  errorMessage?: string,
): Promise<boolean> {
  const res = await ctx.pg.query(
    `
    UPDATE public.agent_runs
    SET status = $2,
        completed_at = now(),
        error_message = $3,
        resumable = ($2 = 'interrupted'),
        claimed_by = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = $1
      AND claimed_by = $4
      AND lease_generation = $5
      AND status IN ('running', 'waiting_model', 'running_tool')
    RETURNING id
    `,
    [ctx.runId, outcome, errorMessage ?? null, workerId, ctx.leaseGeneration],
  );
  return res.rows.length > 0;
}
