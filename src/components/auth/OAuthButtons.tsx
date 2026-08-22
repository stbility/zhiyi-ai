"use client";

import { useMemo, useState } from "react";

import {
  GitHubMark,
  GoogleMark,
  MicrosoftMark,
} from "@/components/auth/BrandMarks";
import { Button } from "@/components/primitives/Button";
import { translateAuthError } from "@/lib/auth/errors";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { OAuthProvider } from "@/lib/supabase/auth-settings";

/**
 * 第三方登录按钮。
 *
 * 品牌图标用官方规定的路径,不自绘、不换色 —— Google 与 GitHub 都对自家标识的
 * 使用有明确规范,擅自改动既不专业也可能违反其品牌准则。
 *
 * 关于「尚未启用的 Provider 要不要显示」:
 * 用户已明确表示会补上 OAuth 客户端凭据,因此这里按用户决定渲染全部按钮。
 * 但在 Supabase 尚未启用该 Provider 时,按钮会显式标注「待接入」并禁用 ——
 * 让用户点到一个必然报错的按钮,和放一个空按钮是同一件事。
 * Provider 一经启用,按钮自动变为可用,无需改代码。
 */

const PROVIDERS: readonly {
  id: OAuthProvider;
  label: string;
  mark: () => React.ReactElement;
}[] = [
  { id: "google", label: "使用 Google 继续", mark: GoogleMark },
  { id: "azure", label: "使用 Microsoft 继续", mark: MicrosoftMark },
  { id: "github", label: "使用 GitHub 继续", mark: GitHubMark },
];

export function OAuthButtons({
  siteUrl,
  enabled = [],
  showDivider = true,
}: {
  siteUrl: string;
  /** Supabase 中实际已启用的 Provider */
  enabled?: readonly OAuthProvider[] | undefined;
  showDivider?: boolean | undefined;
}) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<OAuthProvider | null>(null);

  if (!supabase) return null;

  async function signIn(provider: OAuthProvider) {
    if (!supabase) return;
    setError(null);
    setPending(provider);

    // 回到用户当前所在的域,而不是一个写死的域名。
    //
    // 真实故障:这个部署挂了三个别名域,而 Cookie 是按域名隔离的。
    // 用户在别名域点登录,回调却固定跳到正式域 —— Supabase 侧三次登录全部成功
    // (日志有 action=login 记录),会话却写在了另一个域上,用户回来一看还是未登录。
    // 表现就是「第三方登录成功了却用不了」。
    //
    // 跟着当前 origin 走,在哪个域登录就在哪个域拿到会话,这个问题从根上消失。
    // siteUrl 仅作服务端渲染阶段的兜底(此时还没有 window)。
    const origin =
      typeof window === "undefined" ? siteUrl : window.location.origin;

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${origin}/auth/callback`,
        // 官方强制要求(auth-azure 文档):Supabase Auth 需要 Azure 返回有效 email,
        // 必须请求 email scope。运行时缺它会得到 scope=openid → Azure 无 email claim
        // → GoTrue 无法建立用户 → 自动回登录页。google/github 默认返回 email,不受影响。
        ...(provider === "azure" ? { scopes: "email" } : {}),
      },
    });

    if (error) {
      setError(translateAuthError(error.message).message);
      setPending(null);
    }
    // 成功时浏览器会跳转到 Provider,无需复位 pending
  }

  return (
    <div className="flex flex-col gap-2.5">
      {showDivider && (
        <div className="flex items-center gap-3">
          <span className="bg-divider h-px flex-1" />
          <span className="text-fg-tertiary font-zh text-label">或</span>
          <span className="bg-divider h-px flex-1" />
        </div>
      )}

      {PROVIDERS.map((provider) => {
        const isEnabled = enabled.includes(provider.id);
        const Mark = provider.mark;

        return (
          <Button
            key={provider.id}
            type="button"
            variant="secondary"
            disabled={!isEnabled}
            loading={pending === provider.id}
            onClick={() => void signIn(provider.id)}
            title={isEnabled ? undefined : "该登录方式尚未在服务端启用"}
            className="w-full justify-center"
          >
            <Mark />
            {provider.label}
            {!isEnabled && (
              <span className="text-fg-tertiary text-label border-border-default rounded-tag ml-1 border px-1.5">
                待接入
              </span>
            )}
          </Button>
        );
      })}

      {error && (
        <p role="alert" className="text-error font-zh text-caption">
          {error}
        </p>
      )}
    </div>
  );
}
