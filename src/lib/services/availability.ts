import "server-only";

import {
  getMigrationDatabaseUrl,
  getServerEnv,
  getSupabaseCredentials,
} from "@/lib/env/server";
import {
  validateEncryptionKey,
  validateStripeSecretKey,
  validateStripeWebhookSecret,
  validateSupabaseUrl,
  type CredentialIssue,
} from "@/lib/env/validate";

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

export type ServiceStatus =
  | "configured"
  | "unconfigured"
  | "incomplete"
  | "invalid";

export interface ServiceAvailability {
  readonly key: string;
  /** 面向用户的中文名称 */
  readonly label: string;
  readonly status: ServiceStatus;
  /** 缺失的环境变量名。仅列变量名,绝不含变量值。 */
  readonly missing: readonly string[];
  /** 格式错误。填了但填错时给出,内容绝不含变量值。 */
  readonly issues: readonly CredentialIssue[];
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
  issues: readonly (CredentialIssue | null)[] = [],
): ServiceAvailability {
  const missing = required
    .filter((r) => !r.value)
    .map((r) => r.names.join(" 或 "));

  const realIssues = issues.filter((i): i is CredentialIssue => i !== null);

  // 格式错误优先级最高:填了但填错比没填更危险 —— 它会让人误以为已经接通
  const status: ServiceStatus =
    realIssues.length > 0
      ? "invalid"
      : missing.length === 0
        ? "configured"
        : missing.length === required.length
          ? "unconfigured"
          : "incomplete";

  return { key, label, status, missing, issues: realIssues, blocks };
}

export function getServiceAvailability(): readonly ServiceAvailability[] {
  const env = getServerEnv();
  const supabase = getSupabaseCredentials();

  return [
    evaluate(
      "supabase",
      "Supabase(认证与数据)",
      [
        {
          names: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"],
          value: supabase.url,
        },
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
      [validateSupabaseUrl(supabase.url)],
    ),

    evaluate(
      "database",
      "PostgreSQL 直连(迁移)",
      [
        {
          names: ["POSTGRES_URL_NON_POOLING"],
          value: getMigrationDatabaseUrl(),
        },
      ],
      ["执行数据库迁移", "建立 RLS 策略"],
    ),

    evaluate(
      "encryption",
      "密钥加密",
      [{ names: ["ENCRYPTION_KEY"], value: env.ENCRYPTION_KEY }],
      ["在产品内添加模型服务密钥"],
      [validateEncryptionKey(env.ENCRYPTION_KEY)],
    ),

    evaluate(
      "stripe",
      "Stripe(订阅支付)",
      [
        { names: ["STRIPE_SECRET_KEY"], value: env.STRIPE_SECRET_KEY },
        {
          names: [
            "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
            "STRIPE_PUBLISHABLE_KEY",
          ],
          value:
            env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? env.STRIPE_PUBLISHABLE_KEY,
        },
        { names: ["STRIPE_WEBHOOK_SECRET"], value: env.STRIPE_WEBHOOK_SECRET },
      ],
      // Price ID 不再判为必需:主支付路径是 Payment Link(不依赖 env),
      // checkout 后备路由有 Stripe 目录自解析(price-catalog)。配了只是
      // 显式加速/确定性,缺了不影响任何一条支付路径。状态页口径必须
      // 与支付路径一致 —— 否则「配置不完整」与「支付可用」自相矛盾。
      ["订阅升级", "账单门户", "套餐权益变更"],
      [
        validateStripeSecretKey(env.STRIPE_SECRET_KEY),
        validateStripeWebhookSecret(env.STRIPE_WEBHOOK_SECRET),
      ],
    ),

    evaluate(
      "email",
      "Resend(事务邮件)",
      [{ names: ["RESEND_API_KEY"], value: env.RESEND_API_KEY }],
      ["自定义邮件模板"],
    ),
  ];
}

export function isServiceConfigured(key: string): boolean {
  return (
    getServiceAvailability().find((s) => s.key === key)?.status === "configured"
  );
}
