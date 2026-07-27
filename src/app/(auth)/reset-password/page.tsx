import type { Metadata } from "next";

import { AuthShell } from "@/components/auth/AuthShell";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

export const metadata: Metadata = { title: "重置密码 · 智一 AI" };

export default function ResetPasswordPage() {
  return (
    <AuthShell title="设置新密码" description="设置完成后将自动登录。">
      <ResetPasswordForm />
    </AuthShell>
  );
}
