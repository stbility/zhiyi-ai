"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Icon } from "@/components/icons/Icon";
import { Button, buttonClasses } from "@/components/primitives/Button";
import { IconButton } from "@/components/primitives/IconButton";
import { Select } from "@/components/primitives/Select";
import {
  collectFolderAttachments,
  describeSkipped,
  type Attachment,
} from "@/lib/ai/attachments";
import {
  deleteConversation,
  type AssistantActionState,
} from "@/app/(app)/assistant/actions";
import { cn } from "@/lib/cn";

export interface ModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  /** 供 Select 使用的复合值:providerId::modelId */
  value: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
}

/** 从库里恢复的一条历史消息 */
export interface InitialTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  error: string | null;
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
  /** 本轮附带的文件数,让回看时知道当时给了模型什么 */
  attachedFiles?: number;
}

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

/** 「添加文件夹」的取用规则,按钮提示与表单说明共用同一份文案 */
const FOLDER_HINT =
  "添加文件夹:只读取代码与文本类文件(ts/js/py/go/java/md/json/yaml 等),自动跳过 node_modules、.git、dist 等目录及图片压缩包等二进制文件;不限文件个数,合计上限 120 万字符(约 30–40 万 token);仅对下一条消息生效。";

function toTurn(t: InitialTurn): Turn {
  const turn: Turn = { id: t.id, role: t.role, content: t.content };
  if (t.error) turn.error = t.error;
  if (t.latencyMs !== null) {
    turn.meta = {
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      latencyMs: t.latencyMs,
    };
  }
  return turn;
}

/**
 * AI 助手对话。
 *
 * 逐字流式呈现,用的是真实的模型调用 —— 没有任何模拟或预设回复。
 * 调用失败时如实显示服务商返回的原因,不伪造成功。
 *
 * 历史对话从数据库恢复:关掉页面再回来,能接着上次继续,也能回看模型当时说了什么。
 */
export function ChatPanel({
  models,
  conversations,
  activeConversationId,
  initialTurns,
}: {
  models: readonly ModelOption[];
  conversations: readonly ConversationSummary[];
  activeConversationId: string | null;
  initialTurns: readonly InitialTurn[];
}) {
  const router = useRouter();
  const [, deleteAction] = useActionState<AssistantActionState, FormData>(
    deleteConversation,
    {},
  );
  const [selected, setSelected] = useState(models[0]?.value ?? "");
  const [turns, setTurns] = useState<Turn[]>(() => initialTurns.map(toTurn));
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(
    activeConversationId,
  );
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** 桌面端历史栏是否展开。收起后输出区能多出 224px 宽度 */
  const [historyOpen, setHistoryOpen] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // 切换对话时不在 effect 里同步 state —— 那会引起级联渲染。
  // 由页面给本组件传 key(对话 id),切换时 React 直接重挂,
  // 上面几个 useState 的初始值天然就是新对话的数据。

  // 新内容到达时滚到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // 组件卸载时中止进行中的请求,避免继续消耗配额
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function onPickFolder(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    // 允许重复选同一个目录:清空 value,否则第二次不触发 change
    e.target.value = "";
    if (files.length === 0) return;

    const { attachments: picked, skipped } = await collectFolderAttachments(files);
    setAttachments(picked);

    const note = describeSkipped(skipped);
    setAttachNote(
      picked.length === 0
        ? `没有可用的文本文件。${note}`
        : `已附带 ${picked.length} 个文件${note ? `,${note}` : ""}`,
    );
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (content === "" || streaming) return;

    const [providerId, modelId] = selected.split("::");
    if (!providerId || !modelId) return;

    const sentFiles = attachments.length;
    const userTurn: Turn = {
      id: `u-${Date.now()}`,
      role: "user",
      content,
      ...(sentFiles > 0 ? { attachedFiles: sentFiles } : {}),
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
          ...(attachments.length > 0 ? { attachments } : {}),
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
            | {
                inputTokens: number | null;
                outputTokens: number | null;
                latencyMs: number;
              }
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

      // 附件只作用于发出的那一轮,发完即清 —— 否则下一句会把同一批文件再发一次
      setAttachments([]);
      setAttachNote(null);
      // 让左侧列表出现这次新建的对话
      router.refresh();
    } catch (e) {
      // 用户主动中止不算错误
      if (e instanceof DOMException && e.name === "AbortError") return;

      // 说出真实原因。之前一律显示「网络中断」,而它可能根本不是网络问题 ——
      // 笼统的错误文案等于把线索丢掉,排查时只能靠猜。
      const detail = e instanceof Error && e.message ? e.message : String(e);
      patchAssistant({
        error: `连接中断:${detail}。若反复出现,请把这句提示提供给管理员。`,
      });
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  // 侧栏沿用设计系统导航项的写法(SidebarNavigation):同样的圆角、间距、
  // 选中态 bg-brand-tint text-brand。自己另起一套样式正是「拼装感」的来源。
  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="px-3 pt-3 pb-2">
        <Link
          href="/assistant?c=new"
          onClick={() => setSidebarOpen(false)}
          className={buttonClasses({
            variant: "secondary",
            size: "sm",
            className: "w-full",
          })}
        >
          <Icon name="plus" size={14} />
          新对话
        </Link>
      </div>

      {conversations.length === 0 ? (
        <p className="text-fg-tertiary text-label px-3">还没有对话记录。</p>
      ) : (
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-3">
          {conversations.map((c) => {
            const active = c.id === conversationId;
            return (
              // 用真正的 <a> 而不是 button + router.push。
              // 设计系统在 Button.tsx 里就写明了这条:导航场景应该渲染真正的 <a>,
              // 否则会丢失新标签页打开、右键菜单;而且 router.push 在同路由
              // 只变查询参数时未必触发重新取数,表现就是「点了没反应」。
              // 删除按钮不能嵌在链接里(嵌套可点元素既不合法也不可访问),
              // 所以外面套一层 group,按钮与链接是兄弟节点。
              <div key={c.id} className="group relative">
                <Link
                  href={`/assistant?c=${c.id}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setSidebarOpen(false)}
                  title={c.title}
                  className={cn(
                    "rounded-control flex items-center gap-2.5 py-2.25 pr-8 pl-3 text-left text-[14px]",
                    "transition-colors duration-[var(--duration-hover)] ease-standard",
                    active
                      ? "bg-brand-tint text-brand"
                      : "text-fg-secondary hover:bg-surface-2",
                  )}
                >
                  <Icon name="assistant" size={15} className="shrink-0" />
                  <span className="min-w-0 truncate">{c.title}</span>
                </Link>

                <form
                  action={deleteAction}
                  className="absolute top-1/2 right-1 -translate-y-1/2"
                >
                  <input type="hidden" name="id" value={c.id} />
                  <button
                    type="submit"
                    aria-label={`删除对话「${c.title}」`}
                    title="删除这条对话"
                    // 常态隐藏,免得列表被一排叉号淹没;悬停或键盘聚焦时出现
                    className="text-fg-tertiary hover:text-error rounded-control cursor-pointer p-1 opacity-0 transition-opacity duration-[var(--duration-hover)] ease-standard group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Icon name="x" size={13} />
                  </button>
                </form>
              </div>
            );
          })}
        </nav>
      )}
    </div>
  );

  if (models.length === 0) {
    return (
      <div className="font-zh w-full p-[18px]">
        <div className="border-border-default bg-surface-2 rounded-card border p-5">
          <p className="text-fg text-body mb-1 font-medium">还没有可用的模型</p>
          <p className="text-fg-secondary text-caption">
            请先到「模型服务」添加您的 API
            密钥,并点击「测试连接」——连接成功后可用模型会自动导入。
          </p>
        </div>
      </div>
    );
  }

  return (
    // min-h 是兜底:h-full 依赖祖先链上每一层都有确定高度,
    // 任何一层断掉整块就会塌成 0 —— 表现就是白屏。
    <div className="font-zh flex h-full min-h-[calc(100dvh-3.5rem)] w-full min-w-0">
      {/* 左侧:历史对话。可收起 —— 不需要时把宽度全让给输出内容 */}
      {historyOpen ? (
        <aside className="border-divider hidden w-56 shrink-0 flex-col border-r md:flex">
          <div className="flex items-center justify-between px-3 pt-3">
            <span className="text-fg-tertiary text-label">历史对话</span>
            <IconButton
              aria-label="隐藏历史对话"
              title="隐藏历史对话"
              onClick={() => setHistoryOpen(false)}
              size={24}
            >
              <Icon name="chevronLeft" size={14} />
            </IconButton>
          </div>
          {sidebar}
        </aside>
      ) : (
        <div className="border-divider hidden shrink-0 flex-col items-center border-r px-2 pt-3 md:flex">
          <IconButton
            aria-label="显示历史对话"
            title="显示历史对话"
            onClick={() => setHistoryOpen(true)}
            size={28}
          >
            <Icon name="chevronRight" size={16} />
          </IconButton>
        </div>
      )}

      {/* 窄屏抽屉,避免挤掉对话本身 */}
      {sidebarOpen && (
        <div className="bg-canvas/60 fixed inset-0 z-100 flex md:hidden">
          <div
            role="dialog"
            aria-modal
            aria-label="历史对话"
            onClick={(e) => e.stopPropagation()}
            className="border-border-default bg-surface-1 shadow-flyout w-64 max-w-[80vw] border-r"
          >
            {sidebar}
          </div>
          <button
            type="button"
            aria-label="关闭历史对话"
            className="flex-1"
            onClick={() => setSidebarOpen(false)}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 不再自建标题栏 —— AppChrome 顶部已有一条,再加一条就是两个 header
            摞在一起。窄屏需要一个入口打开历史对话,只保留这一个按钮。 */}
        <div className="flex shrink-0 items-center px-[18px] pt-3 md:hidden">
          <IconButton
            aria-label="打开历史对话"
            onClick={() => setSidebarOpen(true)}
            size={28}
          >
            <Icon name="more" size={16} />
          </IconButton>
        </div>

        <div
          ref={scrollRef}
          className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-[18px] py-5"
        >
          {turns.length === 0 ? (
            <p className="text-fg-tertiary text-caption">
              输入内容开始对话。回复由您配置的模型真实生成,不是预设内容。
            </p>
          ) : (
            turns.map((turn) => (
              // 用户在右、助手在左 —— 设计系统 AIAssistantPanel 的原生规范
              <div
                key={turn.id}
                className={cn(
                  "flex w-full flex-col gap-1",
                  turn.role === "user" ? "items-end" : "items-start",
                )}
              >
                {turn.attachedFiles ? (
                  <span className="text-fg-tertiary text-label">
                    附带 {turn.attachedFiles} 个文件
                  </span>
                ) : null}

                <div
                  className={cn(
                    "text-[14px] leading-[1.6] whitespace-pre-wrap",
                    turn.role === "user"
                      // 用户消息是气泡,靠右 —— 一眼能和 AI 的回答区分开
                      ? "rounded-bubble bg-brand-tint text-fg max-w-[88%] px-3 py-2.5"
                      // AI 回答整幅铺开,不套框。
                      //
                      // 之前用的是设计系统右侧停靠面板的样式(带边框的窄气泡),
                      // 那是给 320px 侧栏设计的;搬到整页对话上,回答被压在一个
                      // 悬浮小框里,再加上左边的历史栏,可读宽度所剩无几。
                      // 长回答和代码块尤其吃亏 —— 这就是「输出框太小」的原因。
                      : "text-fg w-full",
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
                  <p className="text-fg-secondary text-label">
                    {turn.fallback}
                  </p>
                )}

                {turn.error && (
                  <p className="text-error text-label">{turn.error}</p>
                )}

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
            ))
          )}
        </div>

        <form
          onSubmit={send}
          className="border-divider flex shrink-0 flex-col gap-2 border-t p-3.5"
        >
          {/* 格式限制提前说明,而不是等用户选完目录才发现大半被跳过 */}
          {!attachNote && (
            <p className="text-fg-tertiary text-label">{FOLDER_HINT}</p>
          )}

          {attachNote && (
            <div className="border-border-default bg-surface-2 rounded-control flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="text-fg-secondary text-label">{attachNote}</span>
              {attachments.length > 0 && (
                <>
                  {/* 如实说明作用范围,免得用户以为文件会一直跟着对话 */}
                  <span className="text-fg-tertiary text-label">
                    仅对下一条消息生效
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setAttachments([]);
                      setAttachNote(null);
                    }}
                    className="text-fg-tertiary hover:text-fg-secondary text-label cursor-pointer"
                  >
                    移除
                  </button>
                </>
              )}
            </div>
          )}

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
            className="bg-surface-2 border-border-default rounded-control text-fg placeholder:text-fg-tertiary focus:border-border-focus w-full resize-none border px-3 py-2.25 text-[14px] outline-none transition-colors duration-[var(--duration-hover)] ease-standard"
          />

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

            <input
              ref={folderInputRef}
              type="file"
              multiple
              // 目录选择:React 不认识这两个属性,用展开传原生属性
              {...{ webkitdirectory: "", directory: "" }}
              onChange={onPickFolder}
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => folderInputRef.current?.click()}
              title={FOLDER_HINT}
            >
              <Icon name="folder" size={15} />
              添加文件夹
            </Button>

            <Button type="submit" loading={streaming} className="shrink-0">
              <Icon name="send" size={16} />
              发送
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
