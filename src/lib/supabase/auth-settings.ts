import "server-only";

import { getSupabaseCredentials } from "@/lib/env/server";

/**
 * 读取 Supabase 认证服务的真实配置。
 *
 * 为什么要读:登录页上出现哪些第三方登录按钮,必须由 Supabase 里实际启用的
 * Provider 决定,不能在代码里写死。写死的后果是按钮点下去直接报错 ——
 * 也就是产品需求明令禁止的「空按钮」。
 *
 * 这是公开端点,只需可公开密钥;返回的也全是公开配置,不含任何密钥。
 */

/** 产品当前支持展示的第三方登录方式 */
export const SUPPORTED_OAUTH_PROVIDERS = ["github", "google"] as const;

export type OAuthProvider = (typeof SUPPORTED_OAUTH_PROVIDERS)[number];

export interface AuthCapabilities {
  /** 认证服务是否可达 */
  readonly available: boolean;
  /** 是否开放注册 */
  readonly signupEnabled: boolean;
  /** 邮箱密码登录是否可用 */
  readonly emailEnabled: boolean;
  /** 注册后是否要求邮箱验证 */
  readonly requiresEmailConfirmation: boolean;
  /** 实际已启用的第三方登录方式 */
  readonly oauthProviders: readonly OAuthProvider[];
}

const UNAVAILABLE: AuthCapabilities = {
  available: false,
  signupEnabled: false,
  emailEnabled: false,
  requiresEmailConfirmation: true,
  oauthProviders: [],
};

interface SettingsResponse {
  disable_signup?: boolean;
  mailer_autoconfirm?: boolean;
  external?: Record<string, boolean>;
}

export async function getAuthCapabilities(): Promise<AuthCapabilities> {
  const { url, publishableKey } = getSupabaseCredentials();
  if (!url || !publishableKey) return UNAVAILABLE;

  try {
    const response = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: publishableKey },
      // 配置变更不频繁,但也不能永久缓存 —— 否则启用了新 Provider 页面不跟随
      next: { revalidate: 60 },
    });

    if (!response.ok) return UNAVAILABLE;

    const settings = (await response.json()) as SettingsResponse;
    const external = settings.external ?? {};

    return {
      available: true,
      signupEnabled: settings.disable_signup !== true,
      emailEnabled: external["email"] === true,
      requiresEmailConfirmation: settings.mailer_autoconfirm !== true,
      oauthProviders: SUPPORTED_OAUTH_PROVIDERS.filter(
        (provider) => external[provider] === true,
      ),
    };
  } catch {
    // 网络不可达时如实降级为「不可用」,不猜测其能力
    return UNAVAILABLE;
  }
}
