/**
 * Usage exactly-once(阶段 E,Phase 2.2 §10)。
 *
 * 原则:一个成功落库的 agent_step 对应一次 usage 计量。
 * 实现:step INSERT + usage UPSERT 在**同一事务**内原子提交。
 *
 * Runner 是 service role 进程(无用户会话),不能调 bump_usage RPC
 * (0035 强制 auth.uid() 绑定调用者)。合规路径:直接 UPSERT
 * usage_metering(0035 注释明确"写只走 service_role RPC")。
 *
 * 崩溃点保证(Phase 2.2 §10.2):
 *   - step 写后 usage 前崩溃 → 事务回滚 → step 也不存在(无漏计)
 *   - usage 写后 checkpoint 前崩溃 → 事务回滚 → 全无(重跑该步)
 *   - 恢复时 rebuildMessagesFromSteps 只重建不重跑 → 不重复计量
 */

export interface UsageBump {
  userId: string;
  periodMonth: string; // 'YYYY-MM'(UTC)
  category: "agent_turns";
  units: number;
}

/** 生成 UTC 的 YYYY-MM 周期(与 0035 bump_usage 同口径) */
export function currentPeriodMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * 在已开启事务的 client 上执行 usage UPSERT(原子语义由事务保证)。
 * 返回更新后的 units 总数。
 */
export async function bumpUsageInTx(
  client: import("pg").PoolClient,
  bump: UsageBump,
): Promise<number> {
  const res = await client.query(
    `
    INSERT INTO public.usage_metering (user_id, period_month, category, units, updated_at)
    VALUES ($1, $2, $3, $4, now())
    ON CONFLICT (user_id, period_month, category)
    DO UPDATE SET units = public.usage_metering.units + EXCLUDED.units,
                  updated_at = now()
    RETURNING units
    `,
    [bump.userId, bump.periodMonth, bump.category, bump.units],
  );
  return (res.rows[0]?.units as number) ?? 0;
}
