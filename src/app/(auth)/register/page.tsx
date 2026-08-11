import type { Metadata } from "next";
import Link from "next/link";

import { AuthShell } from "@/components/auth/AuthShell";
import { RegisterForm } from "@/components/auth/RegisterForm";
import { getSiteUrl } from "@/lib/env/server";
import { getAuthCapabilities } from "@/lib/supabase/auth-settings";

export const metadata: Metadata = { title: "注册 · 智一 AI" };

export default async function RegisterPage() {
  const capabilities = await getAuthCapabilities();

  return (
    <AuthShell
      title="创建账户"
      description="使用邮箱注册,或通过第三方账号继续。"
      footer={
        <>
          已有账户?{" "}
          <Link href="/login" className="text-brand hover:text-brand-hover">
            登录
          </Link>
        </>
      }
    >
      <RegisterForm
        siteUrl={getSiteUrl()}
        oauthProviders={capabilities.oauthProviders}
        signupEnabled={capabilities.signupEnabled}
      />
    </AuthShell>
  );
}
