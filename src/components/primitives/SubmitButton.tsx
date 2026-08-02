"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

import { Icon } from "@/components/icons/Icon";
import { Button, type ButtonProps } from "@/components/primitives/Button";
import { cn } from "@/lib/cn";

/**
 * 会自己显示「进行中」的提交按钮。
 *
 * 存在的理由是一个真实且致命的缺陷:表单动作里有真网络请求 ——
 * 「测试连接」要调服务商接口(15 秒超时,还要逐个探测模型),
 * 删除、恢复要往数据库写。而按钮点下去**没有任何反馈**:
 * 文字不变、不禁用、界面纹丝不动。
 *
 * 于是用户理所当然地认为没点上,再点、再点。而 useActionState 会把
 * 每次提交排队执行 —— 点五下就是五次 15 秒,越点越慢,
 * 最后表现成「按钮全部失效,要点很多下才生效」。
 *
 * 用 useFormStatus 而不是 useActionState 的 isPending:前者是**按表单**
 * 独立的。模型列表里几十个删除按钮共用同一个 action,用 isPending 的话
 * 点其中一个会把其余全部禁用,看起来像整页卡死。
 *
 * 注意:useFormStatus 必须在 <form> 的**子组件**里调用才拿得到状态,
 * 写在渲染 form 的那个组件里只会永远拿到 false。
 */
export function SubmitButton({
  children,
  pendingText,
  ...rest
}: Omit<ButtonProps, "type" | "loading"> & {
  children?: ReactNode | undefined;
  /** 进行中时替换的文案。不给就沿用原文案,只是禁用并变灰 */
  pendingText?: string | undefined;
}) {
  const { pending } = useFormStatus();
  return (
    <Button {...rest} type="submit" disabled={pending}>
      {pending && pendingText !== undefined ? pendingText : children}
    </Button>
  );
}

/**
 * 图标形态的提交按钮(列表里的删除等)。
 *
 * 同样的问题、同样的解法。进行中时换成一个「处理中」的图标并禁用 ——
 * 图标按钮本来就没有文案可改,不给状态的话点了完全看不出区别。
 */
export function SubmitIconButton({
  icon,
  size = 12,
  className,
  ...rest
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  size?: number | undefined;
  className?: string | undefined;
  "aria-label": string;
  title?: string | undefined;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      {...rest}
      type="submit"
      disabled={pending}
      className={cn(
        "transition-colors duration-[var(--duration-hover)] ease-standard",
        pending ? "cursor-not-allowed opacity-45" : "cursor-pointer",
        className,
      )}
    >
      <Icon name={pending ? "clock" : icon} size={size} />
    </button>
  );
}

/** 文字链形态的提交按钮(「恢复」这类) */
export function SubmitTextButton({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string | undefined;
  title?: string | undefined;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      {...rest}
      type="submit"
      disabled={pending}
      className={cn(
        "transition-colors duration-[var(--duration-hover)] ease-standard",
        pending ? "cursor-not-allowed opacity-45" : "cursor-pointer",
        className,
      )}
    >
      {pending ? "处理中…" : children}
    </button>
  );
}
