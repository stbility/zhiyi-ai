import "server-only";

import { z } from "zod";

/**
 * 服务端环境变量。
 *
 * 设计原则:
 *   1. 只声明真实存在的变量。不写占位密钥,不臆造变量名。
 *   2. 全部字段可选。缺失配置不得让构建或启动失败 —— 而应让对应能力显式变为
 *      「未配置 / 不可用」。这直接落实产品规则:未接通的第三方服务必须如实展示,
 *      不得伪装为已接通,也不得回退到假数据。
 *   3. 校验的是「格式是否合法」,不是「是否存在」。填了但格式错误属于配置错误,
 *      必须暴露;没填属于未配置,是合法状态。
 *   4. 本模块被 server-only 标记,任何客户端组件误引用会在构建期报错,
 *      从而保证密钥不可能进入浏览器产物。
 *
 * AI Provider 的 API 密钥不在这里 —— 它们由用户在产品内添加,加密存于数据库,
 * 见 src/lib/providers/。这里只有加密这些密钥所需的 ENCRYPTION_KEY。
 */

/** 把空字符串视作未设置 —— 避免 `.env` 里 `FOO=` 被当成已配置。 */
const optionalString = z.string().trim().min(1).optional().catch(undefined);

const optionalUrl = z.string().trim().url().optional().catch(undefined);

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // --- Supabase ---------------------------------------------------------
  NEXT_PUBLIC_SUPABASE_URL: optionalUrl,

  // 可公开的客户端密钥。Supabase 现行文档用 PUBLISHABLE_KEY,
  // Vercel 集成历史上生成 ANON_KEY。两者都是真实命名,兼容读取。
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optionalString,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optionalString,

  // 服务端密钥,绕过 RLS。同样兼容新旧两套命名。
  SUPABASE_SECRET_KEY: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,

  SUPABASE_DB_URL: optionalString,

  // --- 应用加密密钥 ------------------------------------------------------
  /** 用于加密存库的第三方 API Key。32 字节 base64。 */
  ENCRYPTION_KEY: optionalString,

  // --- Stripe -----------------------------------------------------------
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: optionalString,

  // --- 站点 -------------------------------------------------------------
  NEXT_PUBLIC_SITE_URL: optionalUrl,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  cached = serverEnvSchema.parse(process.env);
  return cached;
}

/** 仅供测试重置缓存 */
export function resetServerEnvCache(): void {
  cached = undefined;
}

/**
 * 解析后的 Supabase 凭据 —— 屏蔽新旧命名差异,调用方不必关心用的是哪一套。
 */
export interface SupabaseCredentials {
  readonly url: string | undefined;
  readonly publishableKey: string | undefined;
  readonly secretKey: string | undefined;
}

export function getSupabaseCredentials(): SupabaseCredentials {
  const env = getServerEnv();
  return {
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey:
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    secretKey: env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/**
 * 用于日志/错误响应的掩码。永远不要直接输出密钥原文。
 * 保留末 4 位便于运维核对是哪一把 key,其余一律遮蔽。
 */
export function maskSecret(value: string | undefined): string {
  if (!value) return "(未配置)";
  if (value.length <= 8) return "****";
  return `****${value.slice(-4)}`;
}
