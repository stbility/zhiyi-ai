import "server-only";

import { getServerEnv, getSupabaseCredentials } from "@/lib/env/server";

/**
 * 服务可用性注册表。
 *
 * 全站唯一的「某能力当前是否真的可用」判断来源。页面、API、Worker 必须查询这里,
 * 不得各自用 `if (process.env.X)` 各判各的 —— 那正是「未接通却标记为已就绪」的成因。
 *
 * 状态语义严格区分三种,不允许含糊:
 *   configured   —— 凭据齐备,能力可用
 *   unconfigured —— 未提供凭据,能力不可用。UI 必须显示「未配置」,禁止假数据兜底
 *   incomplete   —— 提供了部分凭据,配置不完整。这是配置错误,必须显式暴露
 *
 * 这里只登记「靠环境变量配置的基础设施」。AI Provider 的可用性不在这里 ——
 * Provider 密钥由用户在产品内添加、加密存库,其可用性是每个组织各自的运行时状态,
 * 需要查数据库,见 src/lib/providers/(Phase 3)。
 */

export type ServiceStatus = "configured" | "unconfigured" | "incomplete";

export interface ServiceAvailability {
  readonly key: string;
  /** 面向用户的中文名称 */
  readonly label: string;
  readonly status: ServiceStatus;
  /** 缺失的环境变量名。仅列变量名,绝不含变量值。 */
  readonly missing: readonly string[];
  /** 该服务未配置时,被连带禁用的产品能力,用于 UI 如实说明影响范围 */
  readonly blocks: readonly string[];
}

interface Requirement {
  /** 展示给用户的变量名。多个表示这些命名任填其一即可。 */
  readonly names: readonly string[];
  readonly value: string | undefined;
}

function evaluate(
  key: string,
  label: string,
  required: readonly Requirement[],
  blocks: readonly string[],
): ServiceAvailability {
  const missing = required
    .filter((r) => !r.value)
    .map((r) => r.names.join(" 或 "));

  const status: ServiceStatus =
    missing.length === 0
      ? "configured"
      : missing.length === required.length
        ? "unconfigured"
        : "incomplete";

  return { key, label, status, missing, blocks };
}

export function getServiceAvailability(): readonly ServiceAvailability[] {
  const env = getServerEnv();
  const supabase = getSupabaseCredentials();

  return [
    evaluate(
      "supabase",
      "Supabase(数据库与认证)",
      [
        { names: ["NEXT_PUBLIC_SUPABASE_URL"], value: supabase.url },
        {
          names: [
            "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
            "NEXT_PUBLIC_SUPABASE_ANON_KEY",
          ],
          value: supabase.publishableKey,
        },
        {
          names: ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
          value: supabase.secretKey,
        },
      ],
      ["注册登录", "组织与成员", "知识库", "长期记忆", "工作流执行历史"],
    ),

    evaluate(
      "encryption",
      "密钥加密",
      [{ names: ["ENCRYPTION_KEY"], value: env.ENCRYPTION_KEY }],
      ["在产品内添加模型服务密钥"],
    ),

    evaluate(
      "stripe",
      "Stripe(订阅支付)",
      [
        { names: ["STRIPE_SECRET_KEY"], value: env.STRIPE_SECRET_KEY },
        {
          names: ["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"],
          value: env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
        },
        { names: ["STRIPE_WEBHOOK_SECRET"], value: env.STRIPE_WEBHOOK_SECRET },
      ],
      ["订阅升级", "账单门户", "套餐权益变更"],
    ),
  ];
}

export function isServiceConfigured(key: string): boolean {
  return (
    getServiceAvailability().find((s) => s.key === key)?.status === "configured"
  );
}
