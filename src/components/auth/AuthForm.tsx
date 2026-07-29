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

export type AuthMode = "login" | "register" | "forgot";

const COPY: Record<
  AuthMode,
  { submit: string; pending: string; emailLabel: string }
> = {
  login: { submit: "登录", pending: "登录中…", emailLabel: "邮箱" },
  register: { submit: "创建账户", pending: "创建中…", emailLabel: "邮箱" },
  forgot: { submit: "发送重置邮件", pending: "发送中…", emailLabel: "邮箱" },
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
  const [notice, setNotice] = useState<string | null>(null);

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
    setNotice(null);

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

      // 回调跟随当前所在的域,不写死 —— 这个部署挂了多个别名域,
      // 写死域名会让重置链接把人送到另一个域,会话对不上。
      const origin =
        typeof window === "undefined" ? siteUrl : window.location.origin;

      // 所有认证回调统一走 /auth/callback,再由它转到目的页。
      //
      // 原因是运维现实:Supabase 的重定向白名单被 Supabase–Vercel 集成自动改写,
      // 手动加的条目会被它不断补充新模式,很难长期维持一份精确清单。
      // 与其每加一个页面就回后台加一条白名单(还可能被覆盖),不如让整个应用
      // 只使用**一个**回调地址 —— 它一次进入白名单,之后新增任何页面都不必再动后台。
      //
      // /auth/callback 在服务端完成 code 兑换后按 next 参数转跳,
      // next 经 safeRedirectPath 净化,不构成开放重定向。
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${origin}/auth/callback?next=${encodeURIComponent("/reset-password")}`,
      });
      if (error) {
        setError(translateAuthError(error.message));
        return;
      }
      setNotice("如果该邮箱已注册,重置链接已发送。");
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

          {mode !== "forgot" && (
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
          )}

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
          {notice && (
            <p role="status" className="text-success font-zh text-caption">
              {notice}
            </p>
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

      {mode !== "forgot" && (
        <OAuthButtons
          siteUrl={siteUrl}
          enabled={oauthProviders}
          showDivider={emailEnabled}
        />
      )}

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
