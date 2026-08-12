"use client";

import { useActionState, useState } from "react";

import { Icon } from "@/components/icons/Icon";
import { Button } from "@/components/primitives/Button";
import { TextArea } from "@/components/primitives/TextArea";
import { cn } from "@/lib/cn";
import { SubmitButton } from "@/components/primitives/SubmitButton";
import {
  submitFeedback,
  type FeedbackState,
} from "@/app/(app)/assistant/feedback-actions";
import {
  memorizeMessage,
  type MemoryActionState,
} from "@/app/(app)/assistant/memory-actions";

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
  const [memState, memAction] = useActionState<MemoryActionState, FormData>(
    memorizeMessage,
    {},
  );
  const [editing, setEditing] = useState(false);
  /** 沉淀为记忆的分类选择是否展开 */
  const [memorizing, setMemorizing] = useState(false);
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
  /**
   * 判定按钮。
   *
   * 参考 Claude 的做法:赞/踩用 thumbs 图标,和「复制」放在**同一个操作条**里、
   * 用同一套样式;选中后点亮(赞=成功色,踩=警告色),并保持在选中态。
   *
   * 前面错了两次,记在这里:
   *   ✓ / ✗  —— 读起来是「这个答案对不对」,不是「有没有用」。
   *             用户看到每条回答下面挂个叉号,以为是「这条回答报错了」。
   *   纯文字  —— 「有用 / 没帮上 / 我改成了这样」三个词一字排开,
   *             比回答本身还抢眼,而这是低频动作,不该占这么重的视觉。
   */
  const verdictButton = (
    verdict: "good" | "bad",
    icon: "thumbsUp" | "thumbsDown",
    label: string,
    activeTone: string,
  ) => (
    <form action={action} className="contents">
      <input type="hidden" name="messageId" value={messageId} />
      <input type="hidden" name="verdict" value={verdict} />
      <button
        type="submit"
        aria-label={label}
        title={label}
        aria-pressed={chosen === verdict}
        onClick={() => setChosen(verdict)}
        className={cn(
          "inline-flex cursor-pointer items-center transition-colors duration-[var(--duration-hover)] ease-standard",
          chosen === verdict
            ? activeTone
            : "text-fg-tertiary hover:text-fg-secondary",
        )}
      >
        <Icon name={icon} size={13} />
      </button>
    </form>
  );

  return (
    <div className="flex flex-col gap-2">
      {/* 与「复制」同一条操作行:图标同尺寸、同灰度、同 hover 行为 */}
      <div className="flex flex-wrap items-center gap-3">
        {verdictButton("good", "thumbsUp", "这个回答有用", "text-success")}
        {verdictButton("bad", "thumbsDown", "这个回答没帮上", "text-warning")}

        {/* 编辑入口用 edit 图标,与赞/踩同一条操作行。
            此前是「我改成了这样」五个字,横在每条回答下面比回答还抢眼 ——
            它是最值钱的那条数据,但仍然是低频动作,不该占这么重的视觉。
            语义由 aria-label 与 title 承担,展开后表单里有完整说明。 */}
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          aria-label="我改成了这样"
          title="把你希望的写法写下来 —— 模型写的和你要的之间的差,是最有价值的数据"
          aria-pressed={editing}
          className={cn(
            "inline-flex cursor-pointer items-center transition-colors duration-[var(--duration-hover)] ease-standard",
            editing ? "text-brand" : "text-fg-tertiary hover:text-fg-secondary",
          )}
        >
          <Icon name="edit" size={13} />
        </button>

        {/* 沉淀为记忆。与赞/踩/编辑同一条操作行,同一套视觉 ——
            低频动作,不该占重视觉;语义由 aria-label 与 title 承担。
            这是五条闭环的最后一环:确认过的内容存成记忆,后续对话召回。
            memory 图标与导航里的「记忆」同源,语义一致。 */}
        <button
          type="button"
          onClick={() => setMemorizing((v) => !v)}
          aria-label="沉淀为记忆"
          title="把这条回答的内容记下来,后续对话会召回它"
          aria-pressed={memorizing}
          className={cn(
            "inline-flex cursor-pointer items-center transition-colors duration-[var(--duration-hover)] ease-standard",
            memorizing ? "text-brand" : "text-fg-tertiary hover:text-fg-secondary",
          )}
        >
          <Icon name="memory" size={13} />
        </button>

        {state.ok && <span className="text-success text-label">{state.ok}</span>}
        {state.error && (
          <span className="text-error text-label">{state.error}</span>
        )}
      </div>

      {memorizing && (
        <form action={memAction} className="flex flex-col gap-2">
          <input type="hidden" name="messageId" value={messageId} />
          <p className="text-fg-tertiary text-label">
            沉淀为记忆 —— 后续对话会召回它。给这条记忆分个类:
          </p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["fact", "事实"],
                ["preference", "偏好"],
                ["convention", "约定"],
                ["knowledge", "知识"],
                ["persona", "人设"],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className="bg-surface-2 text-fg font-zh text-label hover:border-border-focus flex cursor-pointer items-center gap-1.5 rounded-control border-border-default border px-3 py-1.5"
              >
                <input
                  type="radio"
                  name="category"
                  value={value}
                  defaultChecked={value === "fact"}
                  className="accent-[var(--color-brand)]"
                />
                {label}
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <SubmitButton size="sm" pendingText="保存中…">
              记住
            </SubmitButton>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setMemorizing(false)}
            >
              取消
            </Button>
          </div>
          {memState.ok && (
            <span className="text-success text-label">{memState.ok}</span>
          )}
          {memState.error && (
            <span className="text-error text-label">{memState.error}</span>
          )}
        </form>
      )}

      {editing && (
        <form action={action} className="flex flex-col gap-2">
          <input type="hidden" name="messageId" value={messageId} />
          <input type="hidden" name="verdict" value="edited" />
          <TextArea
            name="editedText"
            rows={4}
            placeholder="把你希望的写法粘在这里 —— 不用完整,改动的那部分就够"
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
