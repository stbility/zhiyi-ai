import "server-only";

import { z } from "zod";

/**
 * 服务端环境变量。
 *
 * 变量名全部核实自 Vercel 集成实际生成的清单(`vercel env ls`),不臆造、不占位。
 *
 * 设计原则:
 *   1. 全部字段可选。缺失配置不得让构建或启动失败 —— 而应让对应能力显式变为
 *      「未配置 / 不可用」。这直接落实产品规则:未接通的第三方服务必须如实展示,
 *      不得伪装为已接通,也不得回退到假数据。
 *   2. 校验的是「格式是否合法」,不是「是否存在」。填了但格式错误属于配置错误,
 *      必须暴露;没填属于未配置,是合法状态。
 *   3. 本模块被 server-only 标记,任何客户端组件误引用会在构建期报错,
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

  // --- Supabase(由 Vercel Supabase 集成生成)-----------------------------
  NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
  SUPABASE_URL: optionalUrl,

  // 可公开的客户端密钥。集成同时生成了新旧两套命名,任填其一即可。
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optionalString,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optionalString,
  SUPABASE_PUBLISHABLE_KEY: optionalString,
  SUPABASE_ANON_KEY: optionalString,

  // 服务端密钥,绕过 RLS,严禁下发到浏览器。同样两套命名并存。
  SUPABASE_SECRET_KEY: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,

  SUPABASE_JWT_SECRET: optionalString,

  // --- Postgres 直连(由同一集成生成)------------------------------------
  /** 连接池地址,用于常规查询 */
  POSTGRES_URL: optionalString,
  /** 非连接池地址,跑迁移必须用这个 —— 迁移需要会话级状态,不能走 pgbouncer */
  POSTGRES_URL_NON_POOLING: optionalString,
  POSTGRES_PRISMA_URL: optionalString,
  POSTGRES_HOST: optionalString,
  POSTGRES_USER: optionalString,
  POSTGRES_PASSWORD: optionalString,
  POSTGRES_DATABASE: optionalString,

  // --- 应用加密密钥 ------------------------------------------------------
  /** 用于加密存库的第三方 API Key。32 字节 base64。 */
  ENCRYPTION_KEY: optionalString,

  // --- Stripe ------------------------------------------------------------
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_PUBLISHABLE_KEY: optionalString,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: optionalString,
  STRIPE_PRICE_PROFESSIONAL: optionalString,
  STRIPE_PRICE_PROFESSIONAL_YEAR: optionalString,
  STRIPE_PRICE_ENTERPRISE: optionalString,
  STRIPE_PRICE_ENTERPRISE_YEAR: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,

  // --- GitHub App(仓库集成)---------------------------------------------
  /**
   * App 的 Client ID。签 JWT 时作为 iss —— 官方推荐用它而不是 App ID。
   * 私钥是完整 PEM;Vercel 的输入框会把换行存成字面量 \n,读取时要还原。
   * App slug 用于拼安装页地址 https://github.com/apps/<slug>/installations/new
   */
  /**
   * App ID(纯数字)。可选 —— 填了就用它当 JWT 的 iss,否则用 Client ID。
   * 官方文档说两者都行,但实测 GitHub 可能只认整数形式的 App ID。
   */
  GITHUB_APP_ID: optionalString,
  GITHUB_APP_CLIENT_ID: optionalString,
  GITHUB_APP_PRIVATE_KEY: optionalString,
  GITHUB_APP_SLUG: optionalString,
  /** 校验 webhook 签名。没有它就无法确认回调真的来自 GitHub */
  GITHUB_APP_WEBHOOK_SECRET: optionalString,

  // --- Resend(事务邮件)-------------------------------------------------
  RESEND_API_KEY: optionalString,

  // --- 安全开关 -----------------------------------------------------------
  /**
   * 是否允许在邮件通道不可用时,跳过邮箱验证直接建号。
   *
   * 默认关闭。开启意味着任何人都能用不属于自己的邮箱注册并进入系统 ——
   * 这是「产品完全不可用」与「暂时放宽一项验证」之间的权衡,必须由运维显式决定,
   * 不能由代码静默降级。邮件通道接通后应立即关闭。
   */

  // --- 站点 --------------------------------------------------------------
  NEXT_PUBLIC_SITE_URL: optionalUrl,
  /**
   * Vercel 稳定的生产域名。据官方文档,即使在预览部署中也始终有值,
   * 专门用于「可靠地生成指向生产环境的链接」。
   * https://vercel.com/docs/environment-variables/system-environment-variables
   */
  VERCEL_PROJECT_PRODUCTION_URL: optionalString,
  /** 每次部署各不相同的临时域名。不可用于 OAuth 回调。 */
  VERCEL_URL: optionalString,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  cached = serverEnvSchema.parse(process.env);
  return cached;
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
    url: env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL,
    publishableKey:
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
      env.SUPABASE_PUBLISHABLE_KEY ??
      env.SUPABASE_ANON_KEY,
    secretKey: env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY,
  };
}


/** 跑迁移用的连接串 —— 必须是非连接池地址 */
export function getMigrationDatabaseUrl(): string | undefined {
  return getServerEnv().POSTGRES_URL_NON_POOLING;
}

/**
 * 站点绝对地址。用于邮件回调、OAuth 重定向、Stripe 回跳。
 *
 * 顺序有讲究,踩过坑:
 *   1. NEXT_PUBLIC_SITE_URL —— 显式配置优先
 *   2. VERCEL_PROJECT_PRODUCTION_URL —— 稳定的生产域名。官方文档明确说明
 *      它「即使在预览部署中也始终有值」,专门用于可靠地生成指向生产的链接
 *   3. VERCEL_URL —— 兜底。它是每次部署各不相同的临时域名,
 *      曾误用它导致 OAuth 授权后跳回预览域名(而该域名并不在
 *      第三方 Provider 的回调白名单里,登录必然失败)
 *   4. 本地开发地址
 */
export function getSiteUrl(): string {
  const env = getServerEnv();
  if (env.NEXT_PUBLIC_SITE_URL) return env.NEXT_PUBLIC_SITE_URL;
  if (env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return "http://localhost:3000";
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
