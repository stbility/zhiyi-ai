/**
 * 额度数学(纯函数,无 server-only,测试可直接导入)。
 *
 * P0-3 修复的核心:额度拦截必须「配额 - 已用量」,而不是只看配额是否大于零。
 * 配额 null = 不限额度(enterprise);其余 = 本月还剩多少。
 */

/** 本月已用量 → 剩余额度。quota null = 不限,返回 null。 */
export function quotaRemaining(
  quota: number | null,
  used: number,
): number | null {
  if (quota === null) return null;
  return Math.max(0, quota - used);
}

/** 是否应拦截本轮智能体运行。返回被拦截原因;null = 放行。 */
export function agentTurnBlockReason(input: {
  quota: number | null;
  used: number;
}): string | null {
  const remaining = quotaRemaining(input.quota, input.used);
  if (remaining === null) return null; // 不限额度
  if (remaining <= 0) {
    return `本月的智能体运行额度已用完(已用 ${input.used}/${input.quota})。`;
  }
  return null;
}

/** 汇总 get_monthly_usage 返回行(可能多行/类别混杂)为单个数。 */
export function sumUsageRows(rows: readonly { units?: number | null }[]): number {
  return rows.reduce((sum, r) => sum + (r.units ?? 0), 0);
}
