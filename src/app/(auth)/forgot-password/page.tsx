import type { Metadata } from "next";
import Link from "next/link";

import { AuthForm } from "@/components/auth/AuthForm";
import { AuthShell } from "@/components/auth/AuthShell";
import { getSiteUrl } from "@/lib/env/server";
import { getAuthCapabilities } from "@/lib/supabase/auth-settings";

export const metadata: Metadata = { title: "找回密码 · 智一 AI" };

export default async function ForgotPasswordPage() {
  const capabilities = await getAuthCapabilities();

  return (
    <AuthShell
      title="找回密码"
      description="输入注册邮箱,我们会发送重置链接。"
      footer={
        <Link href="/login" className="text-brand hover:text-brand-hover">
          返回登录
        </Link>
      }
    >
      <AuthForm
        mode="forgot"
        siteUrl={getSiteUrl()}
        oauthProviders={capabilities.oauthProviders}
        emailEnabled={capabilities.emailEnabled}
        signupEnabled={capabilities.signupEnabled}
      />
    </AuthShell>
  );
}
