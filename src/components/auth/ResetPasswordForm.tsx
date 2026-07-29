"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * 重置密码。
 *
 * 两个曾经的真实缺陷:
 *
 * 1. 恢复链接从来没被兑换过。@supabase/ssr 的 createBrowserClient 默认走 PKCE,
 *    邮件链接回来带的是 ?code=,必须调 exchangeCodeForSession 才会建立会话。
 *    原先只调 getSession(),于是**拿着完全有效的链接进来也报「无效或已过期」**,
 *    整个重置密码功能等于是坏的。
 *
 * 2. 「直接打开本页」和「链接过期」被混为一谈。用户直接输网址进来,
 *    根本没点过任何链接,却被告知「重置链接无效或已过期」—— 说的不是事实,
 *    也没告诉他该怎么办。两种情况必须分开说。
 */

/** 本页当前处于哪种状态 */
type Phase =
  | "checking"
  | "ready" // 有可用会话,可以设新密码
  | "no-link" // 直接访问,URL 里没有任何恢复参数
  | "bad-link" // 有恢复参数但兑换失败(过期、已用过、被篡改)
  | "unconfigured";

export function ResetPasswordForm() {
  const router = useRouter();
  // 客户端只建一次,避免每次渲染都新建实例
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  // 未配置是渲染时就能确定的事实,直接作为初始值 ——
  // 在 effect 里同步 setState 会触发级联渲染
  const [phase, setPhase] = useState<Phase>(
    supabase ? "checking" : "unconfigured",
  );
  const [linkError, setLinkError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;

    async function resolve() {
      if (!supabase) return;

      const url = new URL(window.location.href);
      // Supabase 失败时把原因放在查询串或 hash 里,原样说给用户听
      const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
      const upstreamError =
        url.searchParams.get("error_description") ??
        url.searchParams.get("error") ??
        hash.get("error_description") ??
        hash.get("error");

      const code = url.searchParams.get("code");
      // 隐式流程会把令牌放在 hash 里,由 detectSessionInUrl 自动处理
      const hasHashToken =
        hash.get("access_token") !== null || hash.get("type") === "recovery";

      if (upstreamError) {
        if (!cancelled) {
          setLinkError(upstreamError);
          setPhase("bad-link");
        }
        return;
      }

      if (code) {
        // PKCE:必须显式兑换,这一步以前整个缺失
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (cancelled) return;
        if (error) {
          setLinkError(error.message);
          setPhase("bad-link");
          return;
        }
        // 兑换成功后把 code 从地址栏抹掉,避免刷新时重复使用(一次性令牌)
        url.searchParams.delete("code");
        window.history.replaceState({}, "", url.pathname + url.search);
        setPhase("ready");
        return;
      }

      const { data } = await supabase.auth.getSession();
      if (cancelled) return;

      if (data.session) {
        // 已登录用户直接改密码也是正当操作,放行
        setPhase("ready");
        return;
      }

      // 带了 hash 令牌却没建立会话 → 链接确实无效;什么都没带 → 是直接访问
      setPhase(hasHashToken ? "bad-link" : "no-link");
    }

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  if (!supabase) {
    return (
      <p className="text-warning font-zh text-caption">
        认证服务未配置,当前无法重置密码。
      </p>
    );
  }

  if (phase === "checking") {
    return (
      <p className="text-fg-tertiary font-zh text-caption">正在校验链接…</p>
    );
  }

  // 直接打开本页 —— 用户没点过任何链接,说「链接失效」是在说假话
  if (phase === "no-link") {
    return (
      <div className="flex flex-col gap-3">
        <div className="border-border-default bg-surface-2 rounded-control p-4">
          <p className="text-fg font-zh text-caption font-medium">
            此页面需要通过重置邮件里的链接打开。
          </p>
          <p className="text-fg-secondary font-zh text-label mt-1.5 leading-[1.7]">
            直接访问本页无法设置密码 —— 系统需要那个一次性令牌来确认是你本人。
            如果你已经登录,可以直接在这里设置新密码。
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => router.push("/forgot-password")}
        >
          去获取重置链接
        </Button>
        <Button variant="ghost" onClick={() => router.push("/login")}>
          返回登录
        </Button>
      </div>
    );
  }

  if (phase === "bad-link") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-error font-zh text-caption">
          重置链接无效或已过期。链接是一次性的,用过或超时都需要重新获取。
        </p>
        {/* 上游给了原因就原样带上,便于排查,不粉饰成笼统一句 */}
        {linkError && (
          <p className="text-fg-tertiary font-zh text-label">
            服务商说明:{linkError}
          </p>
        )}
        <Button
          variant="secondary"
          onClick={() => router.push("/forgot-password")}
        >
          重新发送重置邮件
        </Button>
      </div>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;

    if (password !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }

    setPending(true);
    setError(null);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setError(error.message);
        return;
      }
      router.push("/today");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
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

      {error && (
        <p role="alert" className="text-error font-zh text-caption">
          {error}
        </p>
      )}

      <Button type="submit" loading={pending} className="w-full">
        {pending ? "保存中…" : "设置新密码"}
      </Button>
    </form>
  );
}
