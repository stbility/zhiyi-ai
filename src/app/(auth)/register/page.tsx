import type { Metadata } from "next";
import Link from "next/link";

import { AuthForm } from "@/components/auth/AuthForm";
import { AuthShell } from "@/components/auth/AuthShell";
import { getSiteUrl } from "@/lib/env/server";
import { getAuthCapabilities } from "@/lib/supabase/auth-settings";

export const metadata: Metadata = { title: "注册 · 智一 AI" };

export default async function RegisterPage() {
  const capabilities = await getAuthCapabilities();

  return (
    <AuthShell
      title="创建账户"
      description="注册后需完成邮箱验证才能登录。"
      footer={
        <>
          已有账户?{" "}
          <Link href="/login" className="text-brand hover:text-brand-hover">
            登录
          </Link>
        </>
      }
    >
      <AuthForm
        mode="register"
        siteUrl={getSiteUrl()}
        oauthProviders={capabilities.oauthProviders}
        emailEnabled={capabilities.emailEnabled}
        signupEnabled={capabilities.signupEnabled}
      />
    </AuthShell>
  );
}
