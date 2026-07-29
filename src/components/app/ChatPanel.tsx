"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { Icon } from "@/components/icons/Icon";
import { Button } from "@/components/primitives/Button";
import { Select } from "@/components/primitives/Select";
import { cn } from "@/lib/cn";

export interface ModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  /** 供 Select 使用的复合值:providerId::modelId */
  value: string;
}

interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 助手消息的调用留痕,生成完成后才有 */
  meta?: {
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
  };
  error?: string;
  /** 主模型排队时自动换了模型的说明。必须显示 —— 悄悄换等于伪造来源 */
  fallback?: string;
}

/**
 * AI 助手对话。
 *
 * 逐字流式呈现,用的是真实的模型调用 —— 没有任何模拟或预设回复。
 * 调用失败时如实显示服务商返回的原因,不伪造成功。
 */
/**
 * 复制按钮。
 *
 * 模型回复往往是要拿去用的 —— 手动选中长文本既慢又容易漏。
 * 复制成功后短暂改文案作为反馈,不用弹窗打断。
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板 API 在非安全上下文或被拒权限时会抛错,退回选中复制
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label="复制回复内容"
      className="text-fg-tertiary hover:text-fg-secondary font-zh text-label inline-flex items-center gap-1 transition-colors duration-[var(--duration-hover)] ease-standard"
    >
      <Icon name={copied ? "check" : "copy"} size={13} />
      {copied ? "已复制" : "复制"}
    </button>
  );
}

export function ChatPanel({ models }: { models: readonly ModelOption[] }) {
  const [selected, setSelected] = useState(models[0]?.value ?? "");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 新内容到达时滚到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // 组件卸载时中止进行中的请求,避免继续消耗配额
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  if (models.length === 0) {
    return (
      <div className="border-border-default bg-surface-2 rounded-card font-zh border p-5">
        <p className="text-fg text-body mb-1 font-medium">还没有可用的模型</p>
        <p className="text-fg-secondary text-caption">
          请先到「模型服务」添加您的 API
          密钥,并点击「测试连接」——连接成功后可用模型会自动导入。
        </p>
      </div>
    );
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (content === "" || streaming) return;

    const [providerId, modelId] = selected.split("::");
    if (!providerId || !modelId) return;

    const userTurn: Turn = {
      id: `u-${Date.now()}`,
      role: "user",
      content,
    };
    const assistantTurn: Turn = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: "",
    };

    setTurns((prev) => [...prev, userTurn, assistantTurn]);
    setDraft("");
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const patchAssistant = (patch: Partial<Turn>) => {
      setTurns((prev) =>
        prev.map((t) => (t.id === assistantTurn.id ? { ...t, ...patch } : t)),
      );
    };

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(conversationId ? { conversationId } : {}),
          providerId,
          model: modelId,
          content,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const payload = (await response
          .json()
          .catch(() => ({ error: "请求失败" }))) as { error?: string };
        patchAssistant({ error: payload.error ?? "请求失败" });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const eventLine = block
            .split("\n")
            .find((l) => l.startsWith("event:"));
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;

          const event = eventLine?.slice(6).trim() ?? "delta";

          // 单条事件解析失败不能炸掉整个流 —— 之前一处 JSON.parse 抛错就会被
          // 外层 catch 接住,统一报成「网络中断」,把真实原因彻底盖住。
          let payload:
            | { conversationId: string; model?: string; fallback?: string }
            | { text: string }
            | { inputTokens: number | null; outputTokens: number | null; latencyMs: number }
            | { message: string };
          try {
            payload = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }

          if (event === "meta" && "conversationId" in payload) {
            setConversationId(payload.conversationId);
            if (payload.fallback) patchAssistant({ fallback: payload.fallback });
          } else if (event === "delta" && "text" in payload) {
            text += payload.text;
            patchAssistant({ content: text });
          } else if (event === "done" && "latencyMs" in payload) {
            patchAssistant({
              meta: {
                inputTokens: payload.inputTokens,
                outputTokens: payload.outputTokens,
                latencyMs: payload.latencyMs,
              },
            });
          } else if (event === "error" && "message" in payload) {
            patchAssistant({ error: payload.message });
          }
        }
      }
    } catch (e) {
      // 用户主动中止不算错误
      if (e instanceof DOMException && e.name === "AbortError") return;

      // 说出真实原因。之前一律显示「网络中断」,而它可能根本不是网络问题 ——
      // 笼统的错误文案等于把线索丢掉,排查时只能靠猜。
      const detail =
        e instanceof Error && e.message ? e.message : String(e);
      patchAssistant({
        error: `连接中断:${detail}。若反复出现,请把这句提示提供给管理员。`,
      });
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    // 满屏三段式:消息区独占剩余高度并自行滚动,输入区固定在底部。
    // 所有控件统一在输入区左下角一排 —— 不再散落在顶部和右侧。
    <div className="flex h-full min-h-0 flex-col gap-2.5">
      <div
        ref={scrollRef}
        className="border-border-default bg-surface-2 rounded-card min-h-0 flex-1 overflow-y-auto border px-4 py-4 md:px-6 md:py-5"
      >
        {turns.length === 0 ? (
          <p className="text-fg-tertiary font-zh text-caption">
            输入内容开始对话。回复由您配置的模型真实生成,不是预设内容。
          </p>
        ) : (
          <div className="mx-auto flex w-full max-w-[900px] flex-col gap-5">
            {turns.map((turn) => (
              // 消息按整行铺开、一律左对齐,不再用左右气泡。
              // 气泡把内容压在 92% 宽度里,长回复和代码块在大屏上被挤成窄条 ——
              // 这正是「全屏了内容还是很小」的来源。
              <div key={turn.id} className="font-zh flex flex-col gap-1.5">
                <span className="text-fg-tertiary text-label">
                  {turn.role === "user" ? "你" : "助手"}
                </span>

                <div
                  className={cn(
                    "rounded-card w-full px-3.5 py-3 text-[14px] leading-[1.75] whitespace-pre-wrap",
                    turn.role === "user"
                      ? "bg-brand-tint text-fg"
                      : "bg-surface-3 border-border-default text-fg border",
                  )}
                >
                  {turn.content}
                  {turn.role === "assistant" &&
                    turn.content === "" &&
                    !turn.error &&
                    streaming && (
                      <span className="text-fg-tertiary">正在生成…</span>
                    )}
                </div>

                {turn.fallback && (
                  <p className="text-fg-secondary text-label">{turn.fallback}</p>
                )}

                {turn.error && (
                  <p className="text-error text-label">{turn.error}</p>
                )}

                {/* 回复有内容就给复制入口 —— 长文本手动选中既慢又容易漏 */}
                {turn.role === "assistant" && turn.content !== "" && (
                  <div className="flex items-center gap-3">
                    <CopyButton text={turn.content} />
                    {turn.meta && (
                      <span className="text-fg-tertiary text-label font-mono">
                        {turn.meta.latencyMs} ms
                        {turn.meta.inputTokens !== null &&
                          ` · 输入 ${turn.meta.inputTokens}`}
                        {turn.meta.outputTokens !== null &&
                          ` · 输出 ${turn.meta.outputTokens} token`}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <form
        onSubmit={send}
        className="mx-auto flex w-full max-w-[900px] shrink-0 flex-col gap-2"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送,Shift+Enter 换行 —— 对话场景的通行约定
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(e as unknown as FormEvent);
            }
          }}
          rows={3}
          placeholder="输入内容,Enter 发送,Shift+Enter 换行"
          aria-label="对话输入"
          className="bg-surface-2 border-border-default rounded-control text-fg font-zh placeholder:text-fg-tertiary focus:border-border-focus w-full resize-none border px-3.5 py-3 text-[14px] outline-none transition-colors duration-[var(--duration-hover)] ease-standard"
        />

        {/* 控件统一靠左一排:模型选择在前,发送在后 */}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={selected}
            onChange={setSelected}
            options={models.map((m) => ({
              value: m.value,
              label: `${m.providerName} · ${m.modelId}`,
            }))}
            className="min-w-0 max-w-full"
          />
          <Button type="submit" loading={streaming} className="shrink-0">
            <Icon name="send" size={16} />
            发送
          </Button>
        </div>
      </form>
    </div>
  );
}
