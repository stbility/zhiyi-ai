"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

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
 * 真实调用 Supabase Auth,不做任何前端模拟。Supabase 未配置时禁用提交并如实说明,
 * 绝不伪造「登录成功」。
 *
 * 错误信息一律来自 Supabase 的真实响应,不编造成功状态;
 * 但注册与找回密码不回显「该邮箱是否已注册」,避免账号枚举。
 */
export function AuthForm({
  mode,
  siteUrl,
}: {
  mode: AuthMode;
  siteUrl: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const supabase = createSupabaseBrowserClient();
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
          setError(error.message);
          return;
        }
        router.push("/today");
        router.refresh();
        return;
      }

      if (mode === "register") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${siteUrl}/auth/callback` },
        });
        if (error) {
          setError(error.message);
          return;
        }
        // 不回显账号是否已存在 —— 无论新老账号都给同一句提示
        setNotice("验证邮件已发送,请前往邮箱完成验证后再登录。");
        return;
      }

      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${siteUrl}/auth/reset`,
      });
      if (error) {
        setError(error.message);
        return;
      }
      setNotice("如果该邮箱已注册,重置链接已发送。");
    } finally {
      setPending(false);
    }
  }

  async function signInWithGitHub() {
    if (!supabase) return;
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: `${siteUrl}/auth/callback` },
    });
    if (error) setError(error.message);
  }

  return (
    <div className="flex flex-col gap-4">
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
          <p role="alert" className="text-error font-zh text-caption">
            {error}
          </p>
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

      {mode !== "forgot" && (
        <>
          <div className="flex items-center gap-3">
            <span className="bg-divider h-px flex-1" />
            <span className="text-fg-tertiary font-zh text-label">或</span>
            <span className="bg-divider h-px flex-1" />
          </div>

          <Button
            type="button"
            variant="secondary"
            onClick={signInWithGitHub}
            className="w-full"
          >
            使用 GitHub 继续
          </Button>
        </>
      )}

      {mode === "login" && (
        <p className="text-fg-tertiary font-zh text-caption text-center">
          <Link href="/forgot-password" className="text-brand hover:text-brand-hover">
            忘记密码
          </Link>
        </p>
      )}
    </div>
  );
}
