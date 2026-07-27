import type { Metadata } from "next";
import Link from "next/link";

import { AuthForm } from "@/components/auth/AuthForm";
import { AuthShell } from "@/components/auth/AuthShell";
import { getSiteUrl } from "@/lib/env/server";

export const metadata: Metadata = { title: "登录 · 智一 AI" };

export default function LoginPage() {
  return (
    <AuthShell
      title="登录"
      description="使用邮箱与密码登录,或通过 GitHub 继续。"
      footer={
        <>
          还没有账户?{" "}
          <Link href="/register" className="text-brand hover:text-brand-hover">
            免费注册
          </Link>
        </>
      }
    >
      <AuthForm mode="login" siteUrl={getSiteUrl()} />
    </AuthShell>
  );
}
