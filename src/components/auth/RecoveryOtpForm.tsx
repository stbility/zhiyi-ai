"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { translateAuthError } from "@/lib/auth/errors";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * 找回密码 —— Recovery OTP 三屏流程。
 *
 * 最终产品 UX 为「邮箱验证码」,不再以点击邮件链接作为主流程:
 *
 *   输入注册邮箱 → 发送 Recovery 邮件(含 8 位验证码)
 *   → 输入验证码 → verifyOtp({ email, token, type: "recovery" })
 *   → Recovery Session → 设置新密码(updateUser) → 返回登录
 *
 * 全部复用 Supabase Auth 官方能力,不创建自定义 OTP 系统:
 *   - 发码:supabase.auth.resetPasswordForEmail(email)
 *   - 验证:supabase.auth.verifyOtp({ email, token, type: "recovery" })
 *     (auth-js 官方支持 recovery 类型;GoTrue verify 成功后签发 Recovery Session)
 *   - 改密:supabase.auth.updateUser({ password })
 *
 * 验证码位数以生产真实配置为准:mailer_otp_length = 8(实证)。
 */

/** 生产 mailer_otp_length = 8(实证),UI 校验与文案以 8 位为准 */
const OTP_LENGTH = 8;

/** 重新发送冷却秒数。GoTrue 对 recover 有邮件限流,给一个保守的本地冷却 */
const RESEND_COOLDOWN_SECONDS = 60;

type Phase = "email" | "otp" | "password" | "done";

export function RecoveryOtpForm() {
  const router = useRouter();
  // 客户端只建一次,避免每次渲染都新建实例
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [phase, setPhase] = useState<Phase>("email");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [],
  );

  function startCooldown() {
    setCooldown(RESEND_COOLDOWN_SECONDS);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  if (!supabase) {
    return (
      <div className="border-warning-tint bg-warning-tint rounded-control p-4">
        <p className="text-warning font-zh text-caption">
          认证服务未配置,当前无法重置密码。
        </p>
      </div>
    );
  }

  /** 第一屏:输入邮箱,发送 Recovery 邮件 */
  async function sendCode(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;

    setPending(true);
    setError(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email);
      if (error) {
        setError(translateAuthError(error.message).message);
        return;
      }
      // 防枚举:无论邮箱是否注册都进入下一屏,不在此区分
      setPhase("otp");
      startCooldown();
    } finally {
      setPending(false);
    }
  }

  /** 第二屏:输入 8 位验证码,建立 Recovery Session */
  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;

    const trimmed = token.trim();
    if (trimmed.length !== OTP_LENGTH) {
      setError(`请输入 ${OTP_LENGTH} 位验证码。`);
      return;
    }

    setPending(true);
    setError(null);
    try {
      const { error } = await supabase.auth.verifyOtp({
        email,
        token: trimmed,
        type: "recovery",
      });
      if (error) {
        // OTP 场景的专属文案:过期与限流是用户最常遇到的两种情况
        if (/expired|otp_expired|invalid or has expired/i.test(error.message)) {
          setError("验证码已过期,请重新发送。");
        } else if (
          /for security purposes|rate limit|too many/i.test(error.message)
        ) {
          const t = translateAuthError(error.message);
          setError(
            t.message + (t.hint ? ` ${t.hint}` : "请稍后再试。"),
          );
        } else {
          setError(translateAuthError(error.message).message);
        }
        return;
      }
      // verifyOtp 成功即建立 Recovery Session(auth-js _saveSession),
      // 进入第三屏设置新密码
      setPhase("password");
    } finally {
      setPending(false);
    }
  }

  /** 第三屏:设置新密码 */
  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;

    if (password !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }
    if (password.length < 8) {
      setError("密码至少 8 位。");
      return;
    }

    setPending(true);
    setError(null);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setError(translateAuthError(error.message).message);
        return;
      }
      setPhase("done");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div role="alert" className="border-error-tint bg-error-tint rounded-control p-3">
          <p className="text-error font-zh text-caption">{error}</p>
        </div>
      )}

      {phase === "email" && (
        <form onSubmit={sendCode} className="flex flex-col gap-3">
          <p className="text-fg-secondary font-zh text-caption leading-[1.7]">
            请输入注册邮箱,我们将向你的邮箱发送验证码。
          </p>
          <Input
            label="邮箱"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={setEmail}
          />
          <Button type="submit" loading={pending} className="w-full">
            {pending ? "发送中…" : "发送验证码"}
          </Button>
        </form>
      )}

      {phase === "otp" && (
        <form onSubmit={verifyCode} className="flex flex-col gap-3">
          <p className="text-fg-secondary font-zh text-caption leading-[1.7]">
            验证码已发送至:
            <span className="text-fg font-medium">{email}</span>
          </p>
          <Input
            label="验证码"
            type="text"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={OTP_LENGTH}
            placeholder={`${OTP_LENGTH} 位验证码`}
            value={token}
            onChange={setToken}
          />
          <Button type="submit" loading={pending} className="w-full">
            {pending ? "验证中…" : "验证"}
          </Button>
          <div className="flex items-center justify-between">
            {cooldown > 0 ? (
              <span className="text-fg-tertiary font-zh text-label">
                {cooldown} 秒后可重新发送
              </span>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  void (async () => {
                    setError(null);
                    setPending(true);
                    const { error } =
                      await supabase!.auth.resetPasswordForEmail(email);
                    setPending(false);
                    if (error) {
                      setError(translateAuthError(error.message).message);
                      return;
                    }
                    startCooldown();
                  })();
                }}
                className="text-brand hover:text-brand-hover font-zh text-label"
              >
                重新发送验证码
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => setPhase("email")}
              className="text-fg-tertiary hover:text-fg-secondary font-zh text-label"
            >
              更换邮箱
            </button>
          </div>
        </form>
      )}

      {phase === "password" && (
        <form onSubmit={submitPassword} className="flex flex-col gap-3">
          <p className="text-fg-secondary font-zh text-caption leading-[1.7]">
            验证成功,请设置统一登录新密码。
          </p>
          <Input
            label="新密码"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="至少 8 位"
            value={password}
            onChange={setPassword}
          />
          <Input
            label="确认新密码"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="再输入一次"
            value={confirm}
            onChange={setConfirm}
          />
          <Button type="submit" loading={pending} className="w-full">
            {pending ? "保存中…" : "重置密码"}
          </Button>
        </form>
      )}

      {phase === "done" && (
        <div className="flex flex-col gap-3">
          <div className="border-border-default bg-surface-2 rounded-control p-4">
            <p className="text-fg font-zh text-caption font-medium">
              密码已更新
            </p>
            <p className="text-fg-secondary font-zh text-label mt-1.5 leading-[1.7]">
              请使用新密码重新登录。
            </p>
          </div>
          <Button variant="secondary" onClick={() => router.push("/login")} className="w-full">
            返回登录
          </Button>
          <Link
            href="/login"
            className="text-brand hover:text-brand-hover font-zh text-caption text-center"
          >
            前往登录
          </Link>
        </div>
      )}
    </div>
  );
}
