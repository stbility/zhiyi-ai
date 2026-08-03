"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/primitives/Button";
import { Tag } from "@/components/primitives/Tag";
import { SubmitButton } from "@/components/primitives/SubmitButton";
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

  /**
   * 判定按钮。
   *
   * 此前用的是 ✓ / ✗ 两个图标 —— 那是错的:对号叉号表达的是
   * 「这个答案对不对」,而这里问的是「有没有用」。用户的原话是
   * 「输出框下方是错号对号」,他把每条回答下面那个叉号读成了
   * 「这条回答报错了」。图标库里没有点赞/点踩,与其硬凑一个近似的,
   * 不如直接用文字 —— 反馈这种低频动作,说清楚比省地方重要。
   *
   * 用设计系统的 Tag:它本来就是「可点击的状态标签」,
   * 选中后填品牌色,和输入区那两个模式开关同一套视觉。
   */
  const verdictTag = (verdict: "good" | "bad", label: string) => (
    <form action={action} className="contents">
      <input type="hidden" name="messageId" value={messageId} />
      <input type="hidden" name="verdict" value={verdict} />
      <button type="submit" onClick={() => setChosen(verdict)} className="contents">
        <Tag active={chosen === verdict}>{label}</Tag>
      </button>
    </form>
  );

  return (
    <div className="mt-1.5 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {verdictTag("good", "有用")}
        {verdictTag("bad", "没帮上")}
        <Tag active={editing} onClick={() => setEditing((v) => !v)}>
          {editing ? "收起" : "我改成了这样"}
        </Tag>

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
