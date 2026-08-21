import type { Metadata } from "next";
import Link from "next/link";

import { AuthForm } from "@/components/auth/AuthForm";
import { AuthShell } from "@/components/auth/AuthShell";
import { getSiteUrl } from "@/lib/env/server";
import { getAuthCapabilities } from "@/lib/supabase/auth-settings";

export const metadata: Metadata = { title: "登录 · 智一 AI" };

const PROVIDER_NAME: Record<string, string> = {
  google: "Google",
  azure: "Microsoft",
  github: "GitHub",
};

export default async function LoginPage() {
  const capabilities = await getAuthCapabilities();

  // 文案必须跟随真实能力 —— 承诺一个未启用的登录方式,与放一个空按钮性质相同
  const providerNames = capabilities.oauthProviders
    .map((p) => PROVIDER_NAME[p] ?? p)
    .join(" 或 ");
  const description = providerNames
    ? `使用邮箱与密码登录,或通过 ${providerNames} 继续。`
    : "使用邮箱与密码登录。";

  return (
    <AuthShell
      title="登录"
      description={description}
      footer={
        <>
          还没有账户?{" "}
          <Link href="/register" className="text-brand hover:text-brand-hover">
            免费注册
          </Link>
        </>
      }
    >
      <AuthForm
        mode="login"
        siteUrl={getSiteUrl()}
        oauthProviders={capabilities.oauthProviders}
        emailEnabled={capabilities.emailEnabled}
        signupEnabled={capabilities.signupEnabled}
      />
    </AuthShell>
  );
}
