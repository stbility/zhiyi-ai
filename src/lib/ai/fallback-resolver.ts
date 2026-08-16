/**
 * Fallback Resolver —— 动态选择下一合法候选。
 *
 * 不写死任何 "Provider A → Provider B" 映射。
 * 每个候选必须同时满足:
 *   Provider enabled / Model enabled / Credential available /
 *   Capability compatible(经 capabilities.ts 单一事实来源)/
 *   未被尝试过 / 符合 Task Type 要求。
 *
 * 输入:任务类型、用户请求的 Provider+Model、已尝试集合、失败类别。
 * 输出:下一候选;没有合法候选时返回 null(调用方按 fail 处理)。
 */

import {
  capabilityStatus,
  matchTaskCapabilities,
  modelCapabilities,
  type TaskType,
} from "@/lib/ai/capabilities";
import type { P1FailureClass } from "@/lib/ai/failure-classifier";

/** 候选身份:provider_id + model_id(防循环判定用) */
export interface FallbackCandidate {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerName: string;
  readonly enabled: boolean;
  /** 该候选是否已尝试过(由调用方维护 attempted 集合) */
  attempted: boolean;
}

export interface FallbackResolverInput {
  readonly taskType: TaskType;
  /** 用户原始请求(必须最先尝试,失败后才进入 fallback 池) */
  readonly requested: { providerId: string; modelId: string };
  /** 已尝试过的 candidate identity(providerId::modelId) */
  readonly attempted: ReadonlySet<string>;
  /** 触发本次 fallback 的失败类别(供 policy/排序参考,不硬编码) */
  readonly failureClass: P1FailureClass;
  /** 全部可选候选(已通过 loadOrgCandidates / 等价来源) */
  readonly candidates: readonly FallbackCandidate[];
}

/** 候选唯一标识 */
export function candidateKey(c: { providerId: string; modelId: string }): string {
  return `${c.providerId}::${c.modelId}`;
}

/**
 * 解析下一合法候选。
 * 规则(确定性):
 *   1. 排除已尝试(防 A→B→C→A 循环)
 *   2. 排除 disabled
 *   3. 排除能力不兼容(agent 任务需 text+tools+multi_turn;
 *      capabilityStatus 必须 AVAILABLE —— UNKNOWN 不算 AVAILABLE)
 *   4. 剩余候选按原顺序返回第一个(顺序来自候选来源的排序)
 */
export function resolveFallbackCandidate(
  input: FallbackResolverInput,
): FallbackCandidate | null {
  for (const c of input.candidates) {
    if (c.attempted) continue;
    if (!c.enabled) continue;
    const key = candidateKey(c);
    if (input.attempted.has(key)) continue;
    // 与 Primary 相同身份 → 跳过(已尝试过或重复)
    if (candidateKey(c) === candidateKey(input.requested)) continue;

    // Capability Re-Match:必须经 capabilities.ts(单一事实来源)
    const { caps, known } = modelCapabilities(c.modelId);
    if (known) {
      const status = capabilityStatus(caps, input.taskType);
      if (status !== "AVAILABLE") continue;
      const match = matchTaskCapabilities(caps, input.taskType);
      if (!match.compatible) continue;
    }
    // 未知模型:不默认 AVAILABLE,保守跳过(避免未知能力进入执行)
    // —— 与 agent route 的 Capability Gate 行为一致(未知按 text 放行,
    //    但这里是 fallback 候选,要求更高:必须有声明能力)
    if (!known) continue;

    return c;
  }
  return null;
}
