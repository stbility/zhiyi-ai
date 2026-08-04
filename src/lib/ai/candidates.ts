import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadProviderCipher } from "@/lib/ai/credentials";
import type { ProviderCredentials } from "@/lib/ai/gateway";
import { vendorOf } from "@/lib/ai/fallback";
import {
  isPlatformProviderId,
  loadPlatformCandidates,
} from "@/lib/ai/platform-models";
import type { ProviderKind } from "@/lib/providers/registry";

/**
 * 跨**服务商**的候选模型链。
 *
 * 这个文件的存在是因为一个把整个产品打死的缺陷:降级链原本被锁在
 * 用户选中的那**一个** provider 内 ——
 *
 *   .from("ai_models").eq("provider_id", providerId)
 *
 * 而 fallback.ts 的设计注释写得很清楚:「同厂商的模型往往共用一个算力池,
 * DeepSeek 堵的时候通常整家都堵。所以降级要优先跨厂商 —— 否则换了等于没换。」
 *
 * 实现恰恰就是在一家里打转。原因是 vendorOf() 按模型标识里的 `/` 前缀
 * 判断「厂商」:在英伟达上,deepseek-ai/…、z-ai/…、moonshotai/… 看起来是
 * 三个厂商,实际全是英伟达一家的算力池。所谓「跨厂商降级」从来没有真的
 * 跨过服务商。
 *
 * 实际后果(生产实测):英伟达容量塌陷时,同一时刻
 *   NVIDIA  deepseek-v4-flash  284 秒 / 18 token
 *   DeepSeek 官方 同名模型      65 秒 / 6353 token
 * 差两个数量级。而用户明明配好了 DeepSeek 官方,系统一次都没试过它 ——
 * 三个候选全在英伟达,全部慢,对话被吞吐下限杀掉、智能体被单步超时杀掉,
 * 两条线同时不工作。
 *
 * 所以候选必须跨服务商,而且每个候选要带**自己的**密钥 ——
 * 拿 A 家的 key 去调 B 家的模型只会得到 401。
 */

export interface ModelCandidate {
  readonly providerId: string;
  /** 服务商显示名,用于向用户如实说明换到了哪一家 */
  readonly providerName: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string | null;
  readonly modelId: string;
}

/**
 * 取出这个组织**全部**可用的模型,不限于某一个服务商。
 *
 * 过滤条件与助手页的模型列表保持一致:模型启用、没有被标记为不能对话、
 * 且所属服务商也是启用的 —— 否则会把用户明确停用的服务商又拉回来用。
 */
export async function loadOrgCandidates(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<readonly ModelCandidate[]> {
  // 平台免费档 + 用户自己的 BYOK,合成一条候选链。
  //
  // 顺序上把 BYOK 放前面:那是用户自己付费、自己选的服务商,
  // 他的意图优先。平台档是兜底 —— 但对新注册用户来说,
  // 兜底就是全部,而这正是「注册完直接能对话」的实现。
  const [own, platform] = await Promise.all([
    loadByokCandidates(supabase, organizationId),
    loadPlatformFor(supabase, organizationId),
  ]);
  return [...own, ...platform];
}

/** 读组织的 free_only 开关,再据此取平台模型 */
async function loadPlatformFor(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<readonly ModelCandidate[]> {
  const { data } = await supabase
    .from("organizations")
    .select("free_only")
    .eq("id", organizationId)
    .maybeSingle();

  // 读不到时按**免费档**处理,不是按「全放行」。
  // 出错时的默认值要选代价小的那个:少给几个模型,总好过把付费模型
  // 白送给一个我们其实不知道档位的组织。
  const freeOnly = data?.free_only !== false;
  return loadPlatformCandidates(supabase, freeOnly);
}

async function loadByokCandidates(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<readonly ModelCandidate[]> {
  const { data } = await supabase
    .from("ai_models")
    .select(
      "model_id, provider_id, ai_providers!inner(id, kind, base_url, display_name, enabled)",
    )
    .eq("organization_id", organizationId)
    .eq("enabled", true)
    // 不按「我们判断它不可用」的标记过滤 —— 只认用户自己的开关
    .order("model_id");

  return (data ?? []).flatMap((row) => {
    const p = row.ai_providers as unknown as {
      kind: string;
      base_url: string | null;
      display_name: string;
      enabled: boolean;
    } | null;
    // 服务商被停用时不参与降级 —— 停用是用户的明确决定
    if (!p || p.enabled === false) return [];
    return [
      {
        providerId: row.provider_id as string,
        providerName: p.display_name,
        kind: p.kind as ProviderKind,
        baseUrl: p.base_url,
        modelId: row.model_id as string,
      },
    ];
  });
}

/**
 * 排出尝试顺序。
 *
 * 分层依据是「什么东西一起坏」:
 *   1. 用户选的那个 —— 他的意图优先
 *   2. **别的服务商** —— 这是真正的跨厂商。一家的容量塌了,另一家通常好好的,
 *      这一层才是降级真正起作用的地方。同一层内按服务商轮转(每家先出一个),
 *      避免三次尝试全砸在同一个备用服务商上 —— 那又回到「换了等于没换」。
 *   3. 同一服务商的其它模型家族 —— 聊胜于无,至少不是同一个模型在排队
 *   4. 同一服务商同一家族 —— 最后的兜底
 */
export function orderCandidates(
  all: readonly ModelCandidate[],
  preferredProviderId: string,
  preferredModelId: string,
): readonly ModelCandidate[] {
  const key = (c: ModelCandidate) => `${c.providerId}::${c.modelId}`;
  const seen = new Set<string>();
  const out: ModelCandidate[] = [];

  const take = (c: ModelCandidate) => {
    if (seen.has(key(c))) return;
    seen.add(key(c));
    out.push(c);
  };

  const preferred = all.find(
    (c) => c.providerId === preferredProviderId && c.modelId === preferredModelId,
  );
  // 用户选的模型可能不在列表里(刚被删、或列表还没刷新)。
  // 这种情况下仍然要把它排在第一位:他选了什么就先试什么,
  // 真调不通再由后面的候选接手,而不是直接不试。
  if (preferred) take(preferred);

  // —— 第 2 层:别的服务商,按服务商轮转 ——
  const others = all.filter((c) => c.providerId !== preferredProviderId);
  const byProvider = new Map<string, ModelCandidate[]>();
  for (const c of others) {
    const list = byProvider.get(c.providerId) ?? [];
    list.push(c);
    byProvider.set(c.providerId, list);
  }
  const queues = [...byProvider.values()];
  const deepest = Math.max(0, ...queues.map((q) => q.length));
  for (let i = 0; i < deepest; i++) {
    for (const q of queues) {
      const c = q[i];
      if (c) take(c);
    }
  }

  // —— 第 3 层:同服务商、不同模型家族 ——
  const preferredVendor = vendorOf(preferredModelId);
  for (const c of all) {
    if (c.providerId === preferredProviderId && vendorOf(c.modelId) !== preferredVendor) {
      take(c);
    }
  }

  // —— 第 4 层:同服务商同家族 ——
  for (const c of all) {
    if (c.providerId === preferredProviderId) take(c);
  }

  return out;
}

/**
 * 按需取候选的凭据,同一个服务商只解一次。
 *
 * 密文走 service role 读(迁移 0018 之后 authenticated 读不到密文列),
 * 而授权判断已经由调用方用用户身份完成 —— 候选全部来自
 * loadOrgCandidates,那次查询走的就是用户身份客户端,过得了 RLS
 * 才会出现在这里。顺序不能颠倒。
 */
export function createCredentialLoader(): (
  candidate: ModelCandidate,
) => Promise<ProviderCredentials | null> {
  const cache = new Map<string, ProviderCredentials | null>();

  return async (candidate) => {
    const hit = cache.get(candidate.providerId);
    if (hit !== undefined) return hit;

    // 平台模型的密钥来自环境变量,在装载时就地加密好了 ——
    // 它在 ai_providers 里没有对应的行,拿 providerId 去查密文只会得到 null。
    if (isPlatformProviderId(candidate.providerId)) {
      const cipher = (candidate as { apiKeyCipher?: string }).apiKeyCipher;
      const creds: ProviderCredentials | null = cipher
        ? { kind: candidate.kind, baseUrl: candidate.baseUrl, apiKeyCipher: cipher }
        : null;
      cache.set(candidate.providerId, creds);
      return creds;
    }

    const cipher = await loadProviderCipher(candidate.providerId);
    const creds: ProviderCredentials | null = cipher
      ? {
          kind: candidate.kind,
          baseUrl: candidate.baseUrl,
          apiKeyCipher: cipher,
        }
      : null;
    cache.set(candidate.providerId, creds);
    return creds;
  };
}

/**
 * 换模型时给用户看的说明。
 *
 * 必须说 —— 悄悄换等于拿另一个模型的输出冒充他选的那个。
 * 但只说**换过什么**,不说「谁不可用」:那是判决,而我们经常不知道
 * 真实原因(上游 529、我们自己协议写错、网络抖动,表现是一样的)。
 * 上游原话也不复述 —— 它可能很长,而且对用户没有可操作性。
 *
 * 曾经有第三个参数 reason(失败原因),但函数体从头到尾没用过它 ——
 * 因为上面这条「不说谁不可用」的纪律恰恰要求不用。留着一个永远不被
 * 读取的参数,只会让调用方以为它有影响,还得费神想「这里该传什么」。
 */
export function describeSwitch(
  from: ModelCandidate | { providerName: string; modelId: string },
  to: ModelCandidate,
): string {
  const sameProvider = from.providerName === to.providerName;
  return sameProvider
    ? `本次回复改用了「${to.modelId}」(你选的是「${from.modelId}」)。`
    : `本次回复改用了「${to.providerName} · ${to.modelId}」` +
        `(你选的是「${from.providerName} · ${from.modelId}」)。`;
}
