/**
 * Failure Classifier mapping —— 复用 failure-kind.ts 的既有分类,不重建。
 *
 * failure-kind.ts 已有:permission / upstream-transient / upstream-permanent /
 * transport / platform(基于 HTTP status、ProviderCallError、网络错误形态,
 * 不靠字符串猜测)。
 *
 * 本文件把该分类**映射**到 P1 Runtime Fallback 需要的失败类别:
 *   AUTH_FAILED / RATE_LIMITED / TIMEOUT / PROVIDER_ERROR / MODEL_UNAVAILABLE /
 *   NETWORK_ERROR / INVALID_REQUEST / CAPABILITY_MISMATCH / UNKNOWN
 *
 * 映射依据(不猜测):
 *   - HTTP 401/403            → AUTH_FAILED(failure-kind: permission)
 *   - HTTP 429                → RATE_LIMITED(failure-kind: upstream-transient)
 *   - HTTP 408 / timeout 信号  → TIMEOUT(transport 类)
 *   - HTTP 5xx(除 502/503/504 短暂性外) → PROVIDER_ERROR
 *   - HTTP 404 model / 400 model-not-found → MODEL_UNAVAILABLE
 *   - 网络层(ECONN/ENOTFOUND/ETIMEDOUT) → NETWORK_ERROR
 *   - HTTP 400 参数错          → INVALID_REQUEST
 *   - 能力不匹配               → CAPABILITY_MISMATCH(调用方显式传入)
 *   - 认不出                  → UNKNOWN
 *
 * 无法区分时返回 UNKNOWN 或最接近且有证据支持的类别,禁止猜测。
 */

import {
  FailureKind,
  classifyFailure,
} from "@/lib/ai/failure-kind";
import { ProviderCallError } from "@/lib/ai/gateway";

export type P1FailureClass =
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "MODEL_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "INVALID_REQUEST"
  | "CAPABILITY_MISMATCH"
  | "UNKNOWN";

/** 是否从 ProviderCallError 的 HTTP status 直接判定(证据驱动) */
function fromHttpStatus(status: number | undefined): P1FailureClass | null {
  if (status === undefined) return null;
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 408) return "TIMEOUT";
  if (status === 404) return "MODEL_UNAVAILABLE";
  if (status === 400) return "INVALID_REQUEST";
  if (status >= 500 && status <= 599) return "PROVIDER_ERROR";
  return null;
}

/** 从 failure-kind 映射(已含 HTTP/网络/平台判定) */
function fromFailureKind(kind: FailureKind): P1FailureClass {
  switch (kind) {
    case "permission":
      return "AUTH_FAILED";
    case "upstream-transient":
      // 429/502/503/504 都归到这里 —— 无法区分 RATE_LIMITED 与
      // PROVIDER_ERROR 时按证据保守归 RATE_LIMITED(可重试类)
      return "RATE_LIMITED";
    case "upstream-permanent":
      return "MODEL_UNAVAILABLE";
    case "transport":
      return "NETWORK_ERROR";
    case "platform":
      return "UNKNOWN";
  }
}

/**
 * 统一入口:给定原始异常,输出 P1 失败类别。
 * 优先用 HTTP status 精确判定;无法精确时用 failure-kind 映射;再不行 UNKNOWN。
 */
export function classifyP1Failure(e: unknown): P1FailureClass {
  if (e instanceof ProviderCallError) {
    const byStatus = fromHttpStatus(e.status);
    if (byStatus) return byStatus;
    // ProviderCallError 但无 status:看 failure-kind 的传输判定
    const kind = classifyFailure(e);
    return fromFailureKind(kind);
  }
  const kind = classifyFailure(e);
  return fromFailureKind(kind);
}
