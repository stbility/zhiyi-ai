import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 权益服务(Entitlement Service)。
 *
 * 判断层全部走数据库(0034 的 get_entitlements security definer 函数),
 * 不信任客户端传来的任何 plan 字段 —— 客户端说自己是 enterprise 不算数。
 *
 * 展示层(plans.ts)与判断层(本模块)的分工:
 *   plans.ts    名字、价格文案、feature 列表 —— 展示错了用户看得见
 *   本模块      feature 是否存在、quota 是否够 —— 判断错了是越权
 *
 * 无订阅 = free(0034 函数兜底)。漏配订阅绝不允许等于漏配权益。
 */

export interface EntitlementRow {
  plan_id: "free" | "professional" | "professional_plus" | "team" | "enterprise";
  feature: string;
  quota: number | null;
}

export interface Entitlements {
  readonly planId: "free" | "professional" | "professional_plus" | "team" | "enterprise";
  readonly byFeature: ReadonlyMap<string, number | null>;
}

/** 查询当前用户权益。未登录返回 null;数据库异常返回 null(调用方如实降级)。 */
export async function getMyEntitlements(): Promise<Entitlements | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase.rpc("get_entitlements", {
    p_user_id: user.id,
  });
  if (error) return null; // 网络/鉴权错误 → null,调用方按无订阅处理
  if (!data || !Array.isArray(data)) {
    // RPC 成功但返回空数组 → subscriptions 表无记录 = free plan
    // 不是错误,直接返回 free entitlements
    return { planId: "free" as const, byFeature: new Map() };
  }

  const rows = data as EntitlementRow[];
  const planId = rows[0]?.plan_id ?? "free";
  const byFeature = new Map<string, number | null>();
  for (const row of rows) {
    byFeature.set(row.feature, row.quota);
  }
  return { planId, byFeature };
}

/** 是否拥有某 feature(quota 不限或额度 > 0 都算拥有) */
export function hasFeature(
  entitlements: Entitlements,
  feature: string,
): boolean {
  const quota = entitlements.byFeature.get(feature);
  return quota === null || (quota ?? 0) > 0;
}

/** 某 feature 还剩多少额度。null = 不限;未配置 = 0。 */
export function quotaOf(entitlements: Entitlements, feature: string): number | null {
  const quota = entitlements.byFeature.get(feature);
  return quota ?? 0;
}
