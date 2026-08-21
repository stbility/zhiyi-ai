"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import { OAuthButtons } from "@/components/auth/OAuthButtons";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { translateAuthError, type AuthErrorMessage } from "@/lib/auth/errors";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { OAuthProvider } from "@/lib/supabase/auth-settings";

export type AuthMode = "login" | "register";

const COPY: Record<
  AuthMode,
  { submit: string; pending: string; emailLabel: string }
> = {
  login: { submit: "登录", pending: "登录中…", emailLabel: "邮箱" },
  register: { submit: "创建账户", pending: "创建中…", emailLabel: "邮箱" },
};

/**
 * 认证表单。
 *
 * 真实调用 Supabase Auth,不做任何前端模拟。
 *
 * 第三方登录按钮由 oauthProviders 决定,该列表读自 Supabase 的真实配置 ——
 * 未启用的 Provider 不渲染按钮。写死按钮会得到一个点下去必然报错的空按钮,
 * 那是产品需求明令禁止的。
 *
 * 错误信息一律来自 Supabase 的真实响应,不编造成功状态;
 * 但注册与找回密码不回显「该邮箱是否已注册」,避免账号枚举。
 */
export function AuthForm({
  mode,
  siteUrl,
  oauthProviders = [],
  emailEnabled = true,
  signupEnabled = true,
}: {
  mode: AuthMode;
  siteUrl: string;
  oauthProviders?: readonly OAuthProvider[] | undefined;
  emailEnabled?: boolean | undefined;
  signupEnabled?: boolean | undefined;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AuthErrorMessage | null>(null);

  // 客户端只建一次,避免每次渲染都新建实例
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const copy = COPY[mode];

  if (!supabase) {
    return (
      <div className="border-warning-tint bg-warning-tint rounded-control p-4">
        <p className="text-warning font-zh text-caption">
          认证服务未配置,当前无法注册或登录。
        </p>
        <p className="text-fg-tertiary font-zh text-label mt-2">
          缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_ANON_KEY。
        </p>
      </div>
    );
  }

  if (mode === "register" && !signupEnabled) {
    return (
      <div className="border-warning-tint bg-warning-tint rounded-control p-4">
        <p className="text-warning font-zh text-caption">
          当前未开放注册。
        </p>
      </div>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;

    setPending(true);
    setError(null);

    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) {
          setError(translateAuthError(error.message));
          return;
        }
        router.push("/today");
        router.refresh();
        return;
      }

      // 注册不走这里 —— 见 (auth)/register/actions.ts。
      // 原先这里还有一段 signUp 分支,但 /register 用的是 RegisterForm,
      // 那段代码根本执行不到,却带着「邮箱已注册也报『验证邮件已发送』」
      // 这个已在别处修掉的 bug。死代码留着只会让人以为它还在生效。

      // 找回密码也不在这里 —— 见 (auth)/forgot-password 的 RecoveryOtpForm。
      // 此前这里有一段 resetPasswordForEmail 的 forgot 分支,最终产品 UX 已
      // 改为「邮箱 8 位验证码」三屏流程(RecoveryOtpForm),那段旧的 Recovery
      // Link 主流程代码已移除,避免两套 Recovery 设计并存互相冲突。
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {emailEnabled ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Input
            label={copy.emailLabel}
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={setEmail}
          />

          <Input
            label="密码"
            type="password"
            required
            minLength={8}
            autoComplete={
              mode === "register" ? "new-password" : "current-password"
            }
            placeholder={mode === "register" ? "至少 8 位" : "密码"}
            value={password}
            onChange={setPassword}
          />

          {error && (
            <div role="alert" className="border-error-tint bg-error-tint rounded-control p-3">
              <p className="text-error font-zh text-caption">{error.message}</p>
              {error.hint && (
                <p className="text-fg-tertiary font-zh text-label mt-1">
                  {error.hint}
                </p>
              )}
            </div>
          )}

          <Button type="submit" loading={pending} className="w-full">
            {pending ? copy.pending : copy.submit}
          </Button>
        </form>
      ) : (
        <p className="text-fg-tertiary font-zh text-caption">
          邮箱密码登录未启用。
        </p>
      )}

      <OAuthButtons
        siteUrl={siteUrl}
        enabled={oauthProviders}
        showDivider={emailEnabled}
      />

      {mode === "login" && (
        <p className="text-fg-tertiary font-zh text-caption text-center">
          <Link
            href="/forgot-password"
            className="text-brand hover:text-brand-hover"
          >
            忘记密码
          </Link>
        </p>
      )}
    </div>
  );
}
