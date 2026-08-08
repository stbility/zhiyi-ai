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
 * 这类中间态 —— 因为流程里已经没有邮件这一环了(ALLOW_UNVERIFIED_SIGNUP 语义
 * 见 actions.ts;设为 false 后流程会要求邮箱验证,表单文案如实跟随)。
 */
export function RegisterForm({
  siteUrl,
  oauthProviders = [],
  signupEnabled = true,
}: {
  siteUrl: string;
  oauthProviders?: readonly OAuthProvider[] | undefined;
  signupEnabled?: boolean | undefined;
}) {
  const [state, formAction, pending] = useActionState<RegisterState, FormData>(
    register,
    {},
  );

  // 注册开关(disable_signup):关闭时如实显示,不给假的注册入口。
  if (!signupEnabled) {
    return (
      <div className="border-warning-tint bg-warning-tint rounded-control p-4">
        <p className="text-warning font-zh text-caption">
          当前未开放注册。
        </p>
      </div>
    );
  }

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

  // 邮箱验证模式(ALLOW_UNVERIFIED_SIGNUP 关闭):账号已建,等确认邮件。
  if (state.needsEmailConfirmation) {
    return (
      <div className="flex flex-col gap-3">
        <div className="border-border-default bg-surface-2 rounded-control p-4">
          <p className="text-fg font-zh text-caption font-medium">
            注册成功,请查收确认邮件。
          </p>
          <p className="text-fg-secondary font-zh text-label mt-1.5 leading-[1.7]">
            我们已向该邮箱发送确认邮件,点击其中的链接完成验证后即可登录。
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
    <div className="flex flex-col gap-3">
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
