import "server-only";

/**
 * 凭据格式校验。
 *
 * 「填了」不等于「填对了」。这里检查的是可以在不接触外部服务的前提下、
 * 仅凭格式就能判定的错误 —— 例如把生成命令原文当成密钥填进去,
 * 或把 Webhook 签名密钥填成一个网址。
 *
 * 这类错误如果不检出,表现是运行时才崩、或更糟:验签恒失败却被当成正常。
 * 因此一律归类为「配置错误」并显式展示,不与「未配置」混为一谈。
 *
 * 所有函数只判断格式,绝不回显密钥内容。
 */

export interface CredentialIssue {
  /** 面向用户的问题描述,不含任何密钥内容 */
  readonly message: string;
  /** 如何修正 */
  readonly fix: string;
}

/**
 * ENCRYPTION_KEY 必须是 base64 编码的 32 字节随机数。
 * AES-256-GCM 要求 32 字节密钥;长度不对会在加密时才失败。
 */
export function validateEncryptionKey(
  value: string | undefined,
): CredentialIssue | null {
  if (!value) return null; // 未配置由可用性注册表处理,不是格式错误

  // 常见误填:把生成命令原文粘了进来
  if (/openssl|rand\s|base64\s|^\$\s/i.test(value)) {
    return {
      message: "ENCRYPTION_KEY 的值看起来是生成命令本身,而不是命令的输出",
      fix: "在终端执行 openssl rand -base64 32,把输出的那串随机字符填入",
    };
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return {
      message: "ENCRYPTION_KEY 不是合法的 base64 字符串",
      fix: "执行 openssl rand -base64 32 重新生成",
    };
  }

  let byteLength: number;
  try {
    byteLength = Buffer.from(value, "base64").length;
  } catch {
    return {
      message: "ENCRYPTION_KEY 无法按 base64 解码",
      fix: "执行 openssl rand -base64 32 重新生成",
    };
  }

  if (byteLength !== 32) {
    return {
      message: `ENCRYPTION_KEY 解码后是 ${byteLength} 字节,AES-256 需要 32 字节`,
      fix: "执行 openssl rand -base64 32 重新生成",
    };
  }

  return null;
}

/**
 * STRIPE_WEBHOOK_SECRET 必须是 Stripe 生成的签名密钥,形如 whsec_...
 *
 * 常见误填:填成了 webhook 的接收地址。后果是每一个 webhook 请求验签都失败,
 * 订阅状态永远同步不上;若代码未严格校验,更等于放任伪造的付款成功请求。
 */
export function validateStripeWebhookSecret(
  value: string | undefined,
): CredentialIssue | null {
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    return {
      message: "STRIPE_WEBHOOK_SECRET 被填成了一个网址,而它应该是签名密钥",
      fix: "在 Stripe Dashboard → Developers → Webhooks → 对应 endpoint → Signing secret 复制 whsec_ 开头的值",
    };
  }

  if (!value.startsWith("whsec_")) {
    return {
      message: "STRIPE_WEBHOOK_SECRET 不是以 whsec_ 开头",
      fix: "确认复制的是 Signing secret,而不是 API 密钥或 endpoint 地址",
    };
  }

  return null;
}

/** STRIPE_SECRET_KEY 必须是 sk_ 开头的服务端密钥,不能误填可公开密钥 */
export function validateStripeSecretKey(
  value: string | undefined,
): CredentialIssue | null {
  if (!value) return null;

  if (value.startsWith("pk_")) {
    return {
      message: "STRIPE_SECRET_KEY 被填成了可公开密钥(pk_ 开头)",
      fix: "改填 sk_ 开头的 Secret key;pk_ 应该放在 NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    };
  }

  if (!value.startsWith("sk_") && !value.startsWith("rk_")) {
    return {
      message: "STRIPE_SECRET_KEY 不是以 sk_ 或 rk_ 开头",
      fix: "在 Stripe Dashboard → Developers → API keys 复制 Secret key",
    };
  }

  return null;
}

/** Supabase 地址必须是该项目的 API 域名 */
export function validateSupabaseUrl(
  value: string | undefined,
): CredentialIssue | null {
  if (!value) return null;

  if (!/^https:\/\/[a-z0-9]+\.supabase\.(co|in)\/?$/i.test(value)) {
    return {
      message: "Supabase 地址格式不正确",
      fix: "应形如 https://<project-ref>.supabase.co,取自 Supabase 控制台 → Project Settings → API",
    };
  }

  return null;
}
