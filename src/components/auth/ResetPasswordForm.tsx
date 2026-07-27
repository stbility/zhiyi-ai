"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * 重置密码。
 *
 * 用户点击邮件里的链接后带着恢复会话进入本页,此时可以直接改密码。
 * 若没有有效的恢复会话(链接过期、被直接访问),必须如实说明并要求重新发起,
 * 不能显示一个改了也不生效的表单。
 */
export function ResetPasswordForm() {
  const router = useRouter();
  // 客户端只建一次,避免每次渲染都新建实例
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  // 未配置是渲染时就能确定的事实,直接作为初始值 ——
  // 在 effect 里同步 setState 会触发级联渲染
  const [ready, setReady] = useState<boolean | null>(supabase ? null : false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;

    let cancelled = false;
    // 恢复链接会在此建立一个临时会话;没有会话说明链接无效或已过期
    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setReady(data.session !== null);
    });

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

  if (ready === null) {
    return (
      <p className="text-fg-tertiary font-zh text-caption">正在校验链接…</p>
    );
  }

  if (!ready) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-error font-zh text-caption">
          重置链接无效或已过期。
        </p>
        <Button variant="secondary" onClick={() => router.push("/forgot-password")}>
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
