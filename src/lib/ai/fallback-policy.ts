/**
 * Fallback Policy —— 唯一集中定义「哪类失败允许 fallback」。
 *
 * 禁止散落的 "if error then fallback" 无差别实现。
 * 每条 policy 必须可测试。
 */

import type { P1FailureClass } from "@/lib/ai/failure-classifier";

export type FallbackAction = "fallback" | "rematch" | "no_fallback" | "fail";

export interface FallbackPolicyEntry {
  readonly action: FallbackAction;
  /** 为什么这样定(可读,进日志/审计) */
  readonly reason: string;
}

/**
 * 集中 policy 表。
 *   fallback     → 换 Provider/Model 继续
 *   rematch      → 不执行当前候选,重新做 Capability Matching 再选
 *   no_fallback  → 不换(请求本身的问题,换了也一样)
 *   fail         → 直接失败(平台侧错误,上游从未被调用)
 */
const POLICY_TABLE: Readonly<Record<P1FailureClass, FallbackPolicyEntry>> = {
  AUTH_FAILED: {
    action: "fallback",
    reason: "凭据/权限被拒(401/403),换 Provider 可能换到有效凭据",
  },
  RATE_LIMITED: {
    action: "fallback",
    reason: "限流(429),换 Provider 可绕开当前算力池",
  },
  TIMEOUT: {
    action: "fallback",
    reason: "超时(408/网络超时),换 Provider 可能更快响应",
  },
  PROVIDER_ERROR: {
    action: "fallback",
    reason: "Provider 5xx,换 Provider 绕开故障实例",
  },
  MODEL_UNAVAILABLE: {
    action: "rematch",
    reason: "模型不可用(404),重新做 Capability Matching 选兼容模型",
  },
  NETWORK_ERROR: {
    action: "fallback",
    reason: "网络层断开,换 Provider 可能网络路径不同",
  },
  INVALID_REQUEST: {
    action: "no_fallback",
    reason: "请求本身参数错(400),换了 Provider 也一样失败",
  },
  CAPABILITY_MISMATCH: {
    action: "rematch",
    reason: "能力不匹配,重新匹配能力后再选候选",
  },
  UNKNOWN: {
    action: "no_fallback",
    reason: "无法分类的失败,保守处理:记录,不伪造成功",
  },
};

export function fallbackPolicy(failureClass: P1FailureClass): FallbackPolicyEntry {
  return POLICY_TABLE[failureClass] ?? {
    action: "no_fallback",
    reason: "未知失败类别,保守不 fallback",
  };
}

/** 该失败类别是否允许进入 fallback 流程(含 rematch) */
export function allowsFallback(failureClass: P1FailureClass): boolean {
  const { action } = fallbackPolicy(failureClass);
  return action === "fallback" || action === "rematch";
}

/** 全局上限:单次运行最多尝试的候选数(含 Primary) */
export const MAX_FALLBACK_ATTEMPTS = 3;
