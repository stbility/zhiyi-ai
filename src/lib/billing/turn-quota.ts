import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getMyEntitlements, quotaOf } from "@/lib/billing/entitlements";
import { agentTurnBlockReason, sumUsageRows } from "@/lib/billing/quota-math";

/**
 * 两条 AI 通道共用的额度守卫。
 *
 * 此前这段判断只写在 /api/agent 里,/api/chat 一行都没有 ——
 * 于是免费用户走 AI 助手可以无限调用,套餐里那句「每月 500 次」
 * 只约束得住智能体那一条通道。付费买到的东西和拦得住的东西对不上。
 *
 * 抄一份到 chat 是更坏的做法:turn-preflight.ts 里已经写过为什么 ——
 * 「在这里另写一遍,等于给免费档开了一个不受档位约束的后门」。
 * 授权判定只能有一处实现,所以提到这里,两条通道都调它。
 *
 * 计量口径:两条通道**共用** monthly_agent_turns 与 usage_metering 的
 * agent_turns 类别。理由是权益表(0034)当前只定义了 workflows 与
 * monthly_agent_turns 两项,给助手另立一个 feature 需要改迁移;
 * 而「一个月能调多少次 AI」本来就该是一个数,不是两个各管一半的数。
 * 智能体一轮按步数计量,助手一轮按 1 计量。
 *
 * 纪律(与 quota-math.ts 一致):
 *   quota === null  不限额度(Enterprise)
 *   quota === 0     没额度 / 权益查不到 —— 拦截
 *   异常绝不等于放行:getMyEntitlements 返回 null(RPC、网络、鉴权失败)
 *   按 0 处理,fail-closed。
 */

export interface TurnQuotaBlock {
  /** 给用户看的中文说明,已含用量与升级指引 */
  readonly reason: string;
  readonly used: number;
  readonly quota: number;
}

/**
 * 组织 owner/admin 是否该被豁免。
 *
 * 只豁免**多成员组织**的管理者 —— 注册时自动创建的个人组织只有 1 个成员,
 * 那个 owner 就是普通用户自己,豁免它等于把所有个人用户全部豁免,
 * 套餐额度会彻底失去意义(这是 P0-4 修过的洞,不能因为搬家搬丢了)。
 */
async function isTeamAdmin(
  supabase: SupabaseClient,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const { data: membership } = await supabase
    .from("memberships")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();

  const { count: memberCount } = await supabase
    .from("memberships")
    .select("user_id", { count: "exact" })
    .eq("organization_id", organizationId);

  return (
    (membership?.role === "owner" || membership?.role === "admin") &&
    (memberCount ?? 0) > 1
  );
}

/**
 * 本轮该不该被额度拦下。返回 null = 放行。
 *
 * @param channel 只影响文案 —— 用户看到的是「AI 助手」还是「智能体」,
 *   额度本身两条通道共用一个。
 */
export async function checkTurnQuota(input: {
  readonly supabase: SupabaseClient;
  readonly userId: string;
  readonly organizationId: string;
  readonly channel: "chat" | "agent";
}): Promise<TurnQuotaBlock | null> {
  const { supabase, userId, organizationId, channel } = input;

  if (await isTeamAdmin(supabase, userId, organizationId)) return null;

  const entitlements = await getMyEntitlements();
  // fail-closed:权益查不到按 0(没额度)处理,不按「不限」处理。
  const quota = entitlements
    ? quotaOf(entitlements, "monthly_agent_turns")
    : 0;

  // 配额必须减去本月已用量 —— 只看 quota > 0 等于没有限制。
  let used = 0;
  if (quota !== null) {
    const { data: usage } = await supabase.rpc("get_monthly_usage", {
      p_user_id: userId,
      p_category: "agent_turns",
    });
    used = sumUsageRows((usage ?? []) as { units?: number | null }[]);
  }

  const reason = agentTurnBlockReason({ quota, used });
  if (!reason) return null;

  const 通道 = channel === "chat" ? "AI 助手" : "智能体";
  return {
    reason:
      `${reason}${通道}与智能体共用同一份月度额度。` +
      `升级 Professional(月付 HK128)可提升到每月 2,000 次,` +
      `Enterprise 每月 5,000 次。`,
    used,
    quota: quota ?? 0,
  };
}

/**
 * 记一次 AI 助手用量(1 次 = 1 轮对话)。
 *
 * 只在模型真的回了内容之后调用 —— 失败的调用不该扣用户额度。
 * 计量失败不阻断:漏记一次的危害远小于把已经生成好的回答弄丢。
 * 智能体那侧由 run-journal 的 finish() 按步数计量,两边写的是同一个类别。
 */
export async function meterChatTurn(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  await supabase.rpc("bump_usage", {
    p_user_id: userId,
    p_category: "agent_turns",
    p_units: 1,
  });
}
