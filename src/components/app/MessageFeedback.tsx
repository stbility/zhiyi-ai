"use client";

import { useActionState, useState } from "react";

import { Icon } from "@/components/icons/Icon";
import { Button } from "@/components/primitives/Button";
import { SubmitButton } from "@/components/primitives/SubmitButton";
import { cn } from "@/lib/cn";
import {
  submitFeedback,
  type FeedbackState,
} from "@/app/(app)/assistant/feedback-actions";

/**
 * 回答下方的反馈控件。
 *
 * 「我改成了这样」和 👍👎 同等显眼是刻意的:后者只告诉你好坏,
 * 前者才告诉你**该往哪个方向改**。模型写的和用户要的之间的那个差,
 * 是这整套东西里最值钱的数据 —— 既是评测用例,也是将来微调的成对样本。
 *
 * 只有在消息已经落库(有 id)时才显示。正在生成的那条还没有 id,
 * 给它一个点了会报错的按钮不如不给。
 */
export function MessageFeedback({ messageId }: { messageId: string }) {
  const [state, action] = useActionState<FeedbackState, FormData>(
    submitFeedback,
    {},
  );
  const [editing, setEditing] = useState(false);
  /** 本地记住已提交的判定,让按钮当场变成选中态 —— 不必等整页刷新 */
  const [chosen, setChosen] = useState<string | null>(null);

  const iconButton = (verdict: "good" | "bad", icon: "check" | "x", label: string) => (
    <form action={action} className="contents">
      <input type="hidden" name="messageId" value={messageId} />
      <input type="hidden" name="verdict" value={verdict} />
      <button
        type="submit"
        aria-label={label}
        title={label}
        onClick={() => setChosen(verdict)}
        className={cn(
          "rounded-control flex size-7 cursor-pointer items-center justify-center border",
          "transition-colors duration-[var(--duration-hover)] ease-standard",
          chosen === verdict
            ? "border-brand bg-brand-tint text-brand"
            : "border-transparent text-fg-tertiary hover:bg-surface-3",
        )}
      >
        <Icon name={icon} size={13} />
      </button>
    </form>
  );

  return (
    <div className="mt-1.5 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {iconButton("good", "check", "这个回答有用")}
        {iconButton("bad", "x", "这个回答不对")}

        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="text-fg-tertiary hover:text-brand text-label cursor-pointer px-1.5 py-1"
        >
          {editing ? "收起" : "我改成了这样"}
        </button>

        {state.ok && <span className="text-success text-label">{state.ok}</span>}
        {state.error && (
          <span className="text-error text-label">{state.error}</span>
        )}
      </div>

      {editing && (
        <form action={action} className="flex flex-col gap-2">
          <input type="hidden" name="messageId" value={messageId} />
          <input type="hidden" name="verdict" value="edited" />
          <textarea
            name="editedText"
            rows={4}
            placeholder="把你希望的写法粘在这里 —— 不用完整,改动的那部分就够"
            className="bg-surface-2 text-fg font-zh text-caption rounded-control border-border-default focus:border-border-focus w-full resize-y border px-3 py-2 outline-none"
          />
          <input
            name="reason"
            placeholder="为什么这样改(可不填)"
            className="bg-surface-2 text-fg font-zh text-caption rounded-control border-border-default focus:border-border-focus w-full border px-3 py-2 outline-none"
          />
          <div className="flex gap-2">
            <SubmitButton size="sm" pendingText="保存中…">
              保存
            </SubmitButton>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing(false)}
            >
              取消
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
