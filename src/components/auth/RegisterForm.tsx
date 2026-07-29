"use client";

import Link from "next/link";
import { useActionState } from "react";

import { OAuthButtons } from "@/components/auth/OAuthButtons";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { register, type RegisterState } from "@/app/(auth)/register/actions";
import type { OAuthProvider } from "@/lib/supabase/auth-settings";

/**
 * 注册表单。
 *
 * 走服务端 action 而非浏览器端 signUp —— 原因见 actions.ts:
 * Supabase 内置邮件限流会让注册直接失败且不创建账号,服务端才能在邮件通道
 * 不可用时改走管理员建号路径,保证注册始终可用。
 */
export function RegisterForm({
  siteUrl,
  oauthProviders = [],
}: {
  siteUrl: string;
  oauthProviders?: readonly OAuthProvider[] | undefined;
}) {
  const [state, formAction, pending] = useActionState<RegisterState, FormData>(
    register,
    {},
  );

  // 邮箱已被注册。Supabase 此时不发任何邮件 —— 必须说清楚,
  // 否则用户会一直等一封永远不来的验证信(生产上就是这么卡住的)。
  // 措辞不直接确认该邮箱存在,避免账号枚举。
  if (state.alreadyRegistered) {
    return (
      <div className="flex flex-col gap-3">
        <div className="border-border-default bg-surface-2 rounded-control p-4">
          <p className="text-fg font-zh text-caption font-medium">
            该邮箱已注册过,系统不会重复发送验证邮件。
          </p>
          <p className="text-fg-secondary font-zh text-label mt-1.5 leading-[1.7]">
            请直接登录。如果你当初是用 Google 或 GitHub
            注册的,请用同一种方式登录;忘记密码可通过「忘记密码」重设。
          </p>
        </div>
        <Link
          href="/login"
          className="text-brand hover:text-brand-hover font-zh text-caption text-center"
        >
          前往登录
        </Link>
        <Link
          href="/forgot-password"
          className="text-fg-tertiary hover:text-fg-secondary font-zh text-label text-center"
        >
          忘记密码
        </Link>
      </div>
    );
  }

  if (state.awaitingVerification) {
    return (
      <div className="flex flex-col gap-3">
        <div className="border-success-tint bg-success-tint rounded-control p-4">
          <p className="text-success font-zh text-caption">
            验证邮件已发送。
          </p>
          <p className="text-fg-tertiary font-zh text-label mt-1">
            请前往邮箱点击验证链接,完成后即可登录。若几分钟内没收到,请检查垃圾邮件箱。
          </p>
        </div>
        <Link
          href="/login"
          className="text-brand hover:text-brand-hover font-zh text-caption text-center"
        >
          前往登录
        </Link>
      </div>
    );
  }

  if (state.emailVerificationSkipped) {
    return (
      <div className="flex flex-col gap-3">
        <div className="border-success-tint bg-success-tint rounded-control p-4">
          <p className="text-success font-zh text-caption">
            账户已创建,可以直接登录。
          </p>
        </div>
        {/* 如实告知:这一步跳过了邮箱归属权验证,不粉饰 */}
        <div className="border-warning-tint bg-warning-tint rounded-control p-3">
          <p className="text-warning font-zh text-label">
            本次注册跳过了邮箱验证,因为服务端尚未接入邮件通道。
          </p>
          <p className="text-fg-tertiary font-zh text-label mt-1">
            接入自有 SMTP 后,注册会自动恢复为「先验证邮箱再登录」。
          </p>
        </div>
        <Link
          href="/login"
          className="text-brand hover:text-brand-hover font-zh text-caption text-center"
        >
          前往登录
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-3">
        <Input
          name="email"
          label="邮箱"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
        />
        <Input
          name="password"
          label="密码"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          placeholder="至少 8 位"
        />

        {state.error && (
          <div
            role="alert"
            className="border-error-tint bg-error-tint rounded-control p-3"
          >
            <p className="text-error font-zh text-caption">{state.error}</p>
            {state.hint && (
              <p className="text-fg-tertiary font-zh text-label mt-1">
                {state.hint}
              </p>
            )}
          </div>
        )}

        <Button type="submit" loading={pending} className="w-full">
          {pending ? "创建中…" : "创建账户"}
        </Button>
      </form>

      <OAuthButtons siteUrl={siteUrl} enabled={oauthProviders} />
    </div>
  );
}
