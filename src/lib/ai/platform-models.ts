import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ModelCandidate } from "@/lib/ai/candidates";
import { encryptSecret, isEncryptionAvailable } from "@/lib/crypto/secret-box";
import type { ProviderKind } from "@/lib/providers/registry";
import { logger } from "@/lib/log";

/**
 * 平台提供的模型池。
 *
 * 与用户自己的 BYOK 是两件不同的事:
 *   ai_providers / ai_models  用户自己的密钥,他自己管,想删就删
 *   platform_models           平台提供的,所有组织共享,用户改不了
 *
 * 存在的理由:新用户注册后有了组织,但组织下**一个模型都没有** ——
 * 助手页是空的,什么都做不了。「注册完直接能对话」这条从来没成立过。
 *
 * 【密钥永远不在数据库里】
 * 表里只存**环境变量的名字**。真实密钥在部署环境里,
 * 所以它不进代码库、不进数据库、不下发浏览器,轮换只需改环境变量。
 * 变量没配时该模型直接不出现 —— 不伪装成已接通。
 */

/** 平台模型:候选 + 它属于哪一档 */
export interface PlatformCandidate extends ModelCandidate {
  readonly tier: "free" | "paid";
  /** 平台模型不属于任何组织的 ai_providers,凭据不走 loadProviderCipher */
  readonly apiKeyCipher: string;
}

/**
 * providerId 用的伪标识。
 *
 * 候选链里 providerId 只做两件事:凭据缓存的键、以及「同一服务商」的分组
 * 依据(降级时要跨服务商)。平台模型没有 ai_providers 那张表里的行,
 * 所以给一个稳定的伪标识 —— 前缀让它一眼可辨,也保证不会与真实 uuid 相撞。
 *
 * 必须**按 base_url 分组**而不是全部归一:平台以后接第二家服务商时,
 * 若共用一个 providerId,降级会把它们当成同一家,又回到
 * 「换了等于没换」——那正是 candidates.ts 开头记的那个把产品打死的缺陷。
 */
export function platformProviderId(kind: string, baseUrl: string | null): string {
  return `platform:${kind}:${baseUrl ?? "-"}`;
}

/** 这个伪标识是不是平台模型 —— 凭据装配要据此分流 */
export function isPlatformProviderId(id: string): boolean {
  return id.startsWith("platform:");
}

interface Row {
  kind: string;
  base_url: string | null;
  model_id: string;
  display_name: string;
  api_key_env: string;
  tier: string;
}

/**
 * 取出这个组织能用的平台模型。
 *
 * freeOnly 为 true 时只给 tier='free' —— 这是免费档隔离的**唯一**实现点。
 * 放在这里而不是调用方:分散到每个调用方去过滤,漏一处就是免费用户
 * 白嫖付费模型,而且漏了不会报错。
 *
 * 环境变量没配的直接跳过并记一条 warn:配了目录却没配密钥是部署侧的疏漏,
 * 静默跳过会让「免费档为什么是空的」变成一个查不出原因的现象。
 */
export async function loadPlatformCandidates(
  supabase: SupabaseClient,
  freeOnly: boolean,
): Promise<readonly PlatformCandidate[]> {
  if (!isEncryptionAvailable()) {
    logger.warn({}, "未配置加密密钥,平台模型池不可用");
    return [];
  }

  let query = supabase
    .from("platform_models")
    .select("kind, base_url, model_id, display_name, api_key_env, tier")
    .eq("enabled", true)
    .order("sort_order");

  // 免费档隔离。注意这里用 eq 而不是 neq('paid') ——
  // 以后加了第三档(比如 'trial'),neq 会把它悄悄放行给免费用户,
  // 而 eq 会把它挡在外面。默认拒绝,不是默认放行。
  if (freeOnly) query = query.eq("tier", "free");

  const { data, error } = await query;
  if (error) {
    logger.warn({ dbError: error.message }, "读取平台模型池失败");
    return [];
  }

  const 缺密钥: string[] = [];
  const out = (data ?? []).flatMap((raw): PlatformCandidate[] => {
    const row = raw as unknown as Row;
    const key = process.env[row.api_key_env]?.trim();
    if (!key) {
      缺密钥.push(row.api_key_env);
      return [];
    }
    return [
      {
        providerId: platformProviderId(row.kind, row.base_url),
        providerName: "智一 AI 免费档",
        kind: row.kind as ProviderKind,
        baseUrl: row.base_url,
        modelId: row.model_id,
        tier: row.tier === "paid" ? "paid" : "free",
        // 就地加密成与 BYOK 同一种形态。
        //
        // 下游全部走 decryptSecret(apiKeyCipher),不新开一条明文路径 ——
        // 多一条路径就多一个「某处不小心把明文密钥写进日志/响应」的机会,
        // 而这正是本项目的第一条红线。一次 AES 的开销可以忽略。
        apiKeyCipher: encryptSecret(key),
      },
    ];
  });

  if (缺密钥.length > 0) {
    logger.warn(
      { missing: [...new Set(缺密钥)] },
      "平台模型目录里有条目,但对应的环境变量没配置,已跳过",
    );
  }

  return out;
}

/** 平台模型池当前是否真的可用 —— 界面据此显示「未配置」而不是空白 */
export async function platformPoolAvailable(
  supabase: SupabaseClient,
  freeOnly: boolean,
): Promise<boolean> {
  return (await loadPlatformCandidates(supabase, freeOnly)).length > 0;
}

/**
 * 平台档模型的运行时凭据。
 *
 * 平台免费档在 ai_providers 里**没有行** —— 密钥来自环境变量,装载时已就地
 * 加密(见 loadPlatformCandidates)。chat 与 agent 两条通道共用这一个实现,
 * 授权判定(free_only、环境变量配没配、模型有没有下架)只能有一处。
 * 在这里另写一遍「是平台模型就放行」,等于给免费档开一个不受档位约束的后门。
 */
export async function platformCredentialsFor(
  supabase: SupabaseClient,
  organizationId: string,
  providerId: string,
  modelId: string,
): Promise<{
  readonly kind: ProviderKind;
  readonly baseUrl: string | null;
  readonly apiKeyCipher: string;
} | null> {
  const { data: org } = await supabase
    .from("organizations")
    .select("free_only")
    .eq("id", organizationId)
    .maybeSingle();

  // 读不到时按免费档处理 —— 出错时选代价小的默认值
  const list = await loadPlatformCandidates(supabase, org?.free_only !== false);
  const hit = list.find(
    (c) => c.providerId === providerId && c.modelId === modelId,
  );
  if (!hit) return null;

  return {
    kind: hit.kind,
    baseUrl: hit.baseUrl,
    apiKeyCipher: hit.apiKeyCipher,
  };
}
