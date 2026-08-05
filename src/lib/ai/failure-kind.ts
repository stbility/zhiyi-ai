import "server-only";

import { EncryptionUnavailableError } from "@/lib/crypto/secret-box";
import { ProviderCallError } from "@/lib/ai/gateway";
import { isTransientFailure } from "@/lib/providers/model-filter";

/**
 * 一次调用失败,到底是**谁**的问题。
 *
 * 【为什么必须分清】
 * 真实缺陷:重试判据写成
 *
 *   const 断连 = !(e instanceof ProviderCallError);
 *   const 可重试 = 断连 || isTransientFailure(...);
 *
 * ——**任何**不是 ProviderCallError 的异常都被当成「传输层断了」而重试。
 * 落进这个口子的包括 decryptSecret 抛的 EncryptionUnavailableError
 * (密钥格式坏、密文被改)、以及任何代码 bug 抛的 TypeError。
 *
 * 后果:这些错误**一次上游都没调到**,却会退避 1+2+4+8+8… 一直烧到
 * 预算耗尽(约 285 秒)。用户干等 200 多秒,页面看起来像模型服务商很慢,
 * 而实际上请求从未离开我们的服务器。latency 也证明不了时间花在哪。
 *
 * 根子是**默认放行**:不认识的异常一律当可重试。
 * 这里反过来 —— 只在能**正面认出**是传输故障时才重试,认不出就立刻失败。
 * 立刻失败最坏是让用户重试一次;默认重试最坏是让他白等三分半。
 */

export type FailureKind =
  /** 上游说它忙(429 / 502 / 503 / 504 / 排队)。**有限次**重试有意义 */
  | "upstream-transient"
  /** 上游明确拒绝(400 参数错、404 模型不存在)。重试多少次都一样 */
  | "upstream-permanent"
  /** 凭据/权限被拒(401 / 403 / RLS 挡下)。要人去改配置,不是等 */
  | "permission"
  /** 网络层断了,请求可能压根没送到。**有限次**重试有意义 */
  | "transport"
  /** **我们自己**的问题:密钥解不开、数据库错、参数装配错、代码 bug。
   *  上游从未被调用 —— 重试一万次也一样 */
  | "platform";

/**
 * Node 的 fetch 在网络失败时抛的是 `TypeError: fetch failed`,
 * 真正的原因挂在 `cause` 上(ECONNREFUSED / ENOTFOUND / ECONNRESET…)。
 *
 * 只认这一种形态。别的 TypeError 绝大多数是代码 bug ——
 * 把它当成网络故障去重试,只会让一个必现的 bug 变成三分半的等待。
 */
function 是网络故障(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // errno 形态(ECONNRESET 之类)和**文字形态**都要认。
  //
  // 这一条是被测试抓出来的:流在开口之前断掉时,抛的是
  // `connection reset by peer` —— 没有任何 errno,而 Claude 官方文档
  // 把这一类明确列在「要重试」里。只认 errno 的话,一次真实的断连
  // 会被判成平台错误直接失败,那比原来的缺陷更糟。
  //
  // 收敛的边界在于:这些词描述的都是**连接本身**出了事,
  // 与「密文解不开」「字段为空」这类语义错误没有交集。
  if (
    /fetch failed|network|socket hang up|premature close|connection (?:reset|closed|refused|aborted)|stream (?:closed|error)|terminated|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(
      e.message,
    )
  ) {
    return true;
  }
  const cause = (e as { cause?: unknown }).cause;
  return (
    cause instanceof Error &&
    /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|network|TLS/i.test(
      `${(cause as { code?: string }).code ?? ""} ${cause.message}`,
    )
  );
}

/**
 * 数据库 / RLS / 参数装配这一类,同样是**请求还没出门**就死了。
 *
 * PostgREST 的错误码有固定形态:42501 是权限不足(RLS 挡下),
 * 23xxx 是约束冲突,22xxx 是数据格式。它们全都不该重试 ——
 * 退避再久,一条违反 NOT NULL 的插入还是会违反 NOT NULL。
 */
function 是我们这侧的错(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /PGRST|row-level security|violates|invalid input syntax|null value in column|permission denied for|ZodError|Invalid enum|Required at/i.test(
    e.message,
  );
}

export function classifyFailure(e: unknown): FailureKind {
  // 我们自己的问题优先判 —— 它伪装成别的最危险
  if (e instanceof EncryptionUnavailableError) return "platform";
  if (是我们这侧的错(e)) return "platform";

  if (e instanceof ProviderCallError) {
    // 权限单独一档:401/403 要人去换密钥、改授权,等多久都不会好。
    // 混进 upstream-permanent 的话,报错文案会写成「模型不存在」这类,
    // 把人支去换模型 —— 而该改的是凭据。
    if (e.status === 401 || e.status === 403) return "permission";
    return isTransientFailure(e.status, e.message)
      ? "upstream-transient"
      : "upstream-permanent";
  }

  if (是网络故障(e)) return "transport";

  // 认不出来 = 我们的问题。**默认拒绝重试**,不是默认放行。
  return "platform";
}

/** 只有这两类重试有意义:上游忙、或者根本没送到 */
export function shouldRetry(kind: FailureKind): boolean {
  return kind === "upstream-transient" || kind === "transport";
}

/**
 * 给用户看的话。
 *
 * platform 那一档要**明说上游从未被调用** —— 否则用户会去查服务商状态、
 * 换模型、重连账号,而问题全在我们这边。这一句能省掉他一整轮排查。
 */
export function describeFailureKind(kind: FailureKind, detail: string): string {
  if (kind === "platform") {
    return `本站内部错误,请求未发送到模型服务商(所以与模型快慢无关):${detail}`;
  }
  if (kind === "permission") {
    return `模型服务商拒绝了凭据(重试不会好,需要更换或重新授权):${detail}`;
  }
  return detail;
}

/**
 * 每条路径都必须有**次数上限**,不能只靠剩余预算兜底。
 *
 * 只看预算的话,一个 1 秒就失败的错误会在 285 秒里被重试几十次 ——
 * 日志被刷屏、上游被打、用户干等。次数上限让最坏情况可预期。
 *
 * 5 次配合 1/2/4/8/8 秒退避,总等待约 23 秒 ——
 * 够扛过一次典型的容量抖动,又不会让人觉得卡死。
 */
export const MAX_ATTEMPTS = 5;
