"use client";

import { useState, type FormEvent } from "react";

import { Icon } from "@/components/icons/Icon";
import { IconButton } from "@/components/primitives/IconButton";
import { cn } from "@/lib/cn";

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface AIAssistantPanelProps {
  collapsed?: boolean | undefined;
  onToggle?: (() => void) | undefined;
  /** 当前上下文说明。无上下文时不显示,不得编造。 */
  contextLabel?: string | undefined;
  messages?: readonly AssistantMessage[] | undefined;
  suggestions?: readonly string[] | undefined;
  onSend?: ((text: string) => void) | undefined;
  onSuggestionSelect?: ((suggestion: string) => void) | undefined;
  /** 模型服务未接通时禁用输入,并如实说明原因 */
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
  className?: string | undefined;
}

export function AIAssistantPanel({
  collapsed = false,
  onToggle,
  contextLabel,
  messages = [],
  suggestions = [],
  onSend,
  onSuggestionSelect,
  disabled = false,
  disabledReason,
  className,
}: AIAssistantPanelProps) {
  const [draft, setDraft] = useState("");

  if (collapsed) {
    return (
      <div
        className={cn(
          "border-border-default bg-surface-1 flex h-full w-12 shrink-0 flex-col items-center border-l pt-4",
          className,
        )}
      >
        <IconButton aria-label="展开 AI 助手" onClick={onToggle}>
          <Icon name="assistant" size={18} />
        </IconButton>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || disabled) return;
    onSend?.(text);
    setDraft("");
  };

  return (
    <aside
      aria-label="AI 助手"
      className={cn(
        "border-border-default bg-surface-1 font-zh w-assistant flex h-full shrink-0 flex-col border-l",
        className,
      )}
    >
      <div className="border-divider flex items-center justify-between gap-3 border-b px-[18px] py-4">
        <span className="text-fg flex items-center gap-2 text-[14px] font-medium">
          <Icon name="assistant" size={16} className="text-brand" />
          AI 助手
        </span>
        <IconButton aria-label="收起" onClick={onToggle} size={28}>
          <Icon name="chevronRight" size={16} />
        </IconButton>
      </div>

      {contextLabel && (
        <p className="text-fg-tertiary text-label border-divider border-b px-[18px] py-2.5">
          {contextLabel}
        </p>
      )}

      <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto p-[18px]">
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "rounded-bubble max-w-[88%] px-3 py-2.5 text-[14px] leading-[1.6]",
              message.role === "user"
                ? "bg-brand-tint text-fg self-end"
                : "bg-surface-2 border-border-default text-fg self-start border",
            )}
          >
            {message.text}
          </div>
        ))}

        {suggestions.length > 0 && (
          <div className="mt-1 flex flex-col gap-2">
            <p className="text-fg-tertiary text-label">推荐操作</p>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => onSuggestionSelect?.(suggestion)}
                className="border-border-default rounded-control text-fg-secondary hover:bg-surface-2 cursor-pointer border px-2.5 py-2 text-left text-[13px] transition-colors duration-[var(--duration-hover)] ease-standard"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>

      <form
        onSubmit={submit}
        className="border-divider flex flex-col gap-2 border-t p-3.5"
      >
        <div className="flex items-center gap-2">
          <input
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={disabled ? "模型服务未接通" : "继续提问,或让 AI 执行下一步…"}
            aria-label="向 AI 助手提问"
            className="bg-surface-2 border-border-default rounded-control text-fg font-zh placeholder:text-fg-tertiary focus:border-border-focus min-w-0 flex-1 border px-3 py-2.25 text-[13px] outline-none transition-colors duration-[var(--duration-hover)] ease-standard disabled:opacity-50"
          />
          <IconButton type="submit" aria-label="发送" disabled={disabled}>
            <Icon name="send" size={16} className="text-brand" />
          </IconButton>
        </div>
        {disabled && disabledReason && (
          <p className="text-fg-tertiary text-label">{disabledReason}</p>
        )}
      </form>
    </aside>
  );
}
