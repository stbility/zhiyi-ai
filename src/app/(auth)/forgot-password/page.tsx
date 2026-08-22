import type { Metadata } from "next";
import Link from "next/link";

import { AuthShell } from "@/components/auth/AuthShell";
import { RecoveryOtpForm } from "@/components/auth/RecoveryOtpForm";

export const metadata: Metadata = { title: "重置统一登录密码 · 智一 AI" };

/**
 * 找回密码 —— Recovery OTP 三屏流程(发码 → 验证码 → 设新密码)。
 *
 * 主流程为邮箱验证码,不依赖点击邮件链接:
 *   输入注册邮箱 → 邮件含 8 位验证码 → 输入验证码
 *   → verifyOtp(type="recovery") → Recovery Session → 设置新密码
 */
export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="重置统一登录密码"
      description="通过邮箱验证码重置登录密码,统一适用于所有账户。"
      footer={
        <Link href="/login" className="text-brand hover:text-brand-hover">
          返回登录
        </Link>
      }
    >
      <RecoveryOtpForm />
    </AuthShell>
  );
}
