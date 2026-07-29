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
 * 注册成功后由服务端 action 直接建号、登录并跳转,前端不需要处理「等待验证」
 * 这类中间态 —— 因为流程里已经没有邮件这一环了。原因见 actions.ts。
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
            该邮箱已注册过。
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
