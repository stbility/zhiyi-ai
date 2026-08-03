"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";

import { Icon } from "@/components/icons/Icon";
import { MessageFeedback } from "@/components/app/MessageFeedback";
import { Badge } from "@/components/primitives/Badge";
import { Button, buttonClasses } from "@/components/primitives/Button";
import { IconButton } from "@/components/primitives/IconButton";
import { Select } from "@/components/primitives/Select";
import { Tag } from "@/components/primitives/Tag";
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
  /** 渲染用的稳定 id。刚发出的那条是客户端造的临时值 `a-${Date.now()}` */
  id: string;
  /**
   * 数据库里的真实消息 id。
   *
   * 反馈按钮(👍/👎/我改成了这样)必须用它 —— message_feedback.message_id
   * 是指向 messages 的外键,服务端还会用 Zod 校验它是不是 uuid。
   * 此前这里传的是上面那个临时 id,于是**刚生成的回答点反馈必然失败**,
   * 而那正是唯一想打分的时刻;只有刷新后从历史加载的消息才碰巧能用。
   *
   * 历史消息在 toTurn 里直接带上;新生成的那条由 done 事件回填。
   */
  dbId?: string;
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
  /**
   * 推理模型的思考过程。实时显示,但不是答案。
   *
   * 不显示它的后果很具体:这类模型可能思考几分钟才吐第一个正文字,
   * 期间界面一个字都不动 —— 用户只能判断为「模型不工作」。
   * 显示出来,等待就从「死机」变成「看得见的进行中」。
   */
  reasoning?: string;
  /** 上下文被裁剪的说明 */
  trimming?: string;
  /** 联网检索的说明 */
  search?: string;
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
/** 开关变更事件 —— storage 事件不会在本页触发 */
const TOGGLE_EVENT = "zhiyi-toggle-change";

const FOLDER_HINT =
  "添加文件夹:只读取代码与文本类文件(ts/js/py/go/java/md/json/yaml 等),自动跳过 node_modules、.git、dist 等目录及图片压缩包等二进制文件;不限文件个数,合计上限 120 万字符;文件会保留在本对话,后续每轮提问模型都能看到。";

/**
 * 记得住的开关。
 *
 * 「联网」「智能体」是**模式**而不是一次性动作,用户开了就该一直有效,
 * 直到他自己关掉。
 *
 * 真实故障:新建对话后页面会 router.refresh(),而 ChatPanel 带着
 * key={对话id} —— 对话 id 从 "new" 变成真实 UUID 时 React 会重挂组件,
 * useState 的初始值把开关重置回 false。用户第一条开了智能体,
 * 第二条就莫名其妙变回普通对话,而界面上看不出发生过什么。
 *
 * 用 localStorage + useSyncExternalStore:重挂后仍读到同一个值,
 * 而且服务端快照固定为 false,不会造成水合不一致。
 */
function usePersistentToggle(
  key: string,
): [boolean, (next: boolean | ((v: boolean) => boolean)) => void] {
  const value = useSyncExternalStore(
    (onChange) => {
      window.addEventListener(TOGGLE_EVENT, onChange);
      window.addEventListener("storage", onChange);
      return () => {
        window.removeEventListener(TOGGLE_EVENT, onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    () => window.localStorage.getItem(key) === "on",
    () => false,
  );

  const set = (next: boolean | ((v: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(value) : next;
    window.localStorage.setItem(key, resolved ? "on" : "off");
    // storage 事件只在其它标签页触发,本页要自己发一个
    window.dispatchEvent(new Event(TOGGLE_EVENT));
  };

  return [value, set];
}

/**
 * 把正文里的网址变成可点的链接。
 *
 * 此前正文是纯文本(whitespace-pre-wrap),网址只是一串字符 ——
 * 开了联网检索之后,模型标注的来源全都点不开,只能手动复制粘贴。
 * 对一个要求「必须标注来源」的功能来说,来源点不开等于没标。
 *
 * 只放行 http(s)。正文来自模型,是不可信输入,javascript: 这类伪协议
 * 绝不能进 href。用 React 元素而不是 innerHTML,天然免疫注入。
 */
const URL_PATTERN = /(https?:\/\/[^\s<>()[\]{}"'，。、；：！？]+)/g;

function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const m of text.matchAll(URL_PATTERN)) {
    const url = m[0];
    const at = m.index;
    if (at === undefined) continue;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <a
        key={`u${key++}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand hover:text-brand-hover underline underline-offset-2 break-all"
      >
        {url}
      </a>,
    );
    last = at + url.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

function toTurn(t: InitialTurn): Turn {
  // 从库里恢复的消息,id 本身就是真实的 message id
  const turn: Turn = { id: t.id, dbId: t.id, role: t.role, content: t.content };
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
  initialFileCount,
}: {
  models: readonly ModelOption[];
  conversations: readonly ConversationSummary[];
  activeConversationId: string | null;
  initialTurns: readonly InitialTurn[];
  /** 本对话已关联的项目文件数 */
  initialFileCount: number;
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
  /** 本对话当前关联的项目文件数 —— 附件跨轮保留,不再只作用于一条消息 */
  const [contextFiles, setContextFiles] = useState(initialFileCount);
  /**
   * 本轮是否联网。
   *
   * 由用户显式开启,不让模型自己决定 —— 模型判断「要不要搜」并不可靠,
   * 而每次搜索都消耗配额。显式开关让成本和行为都可预期。
   */
  const [webSearch, setWebSearch] = usePersistentToggle("zhiyi-web-search");
  /**
   * 智能体模式。
   *
   * 开启后模型可以连续调用文件工具,产物直接写进工作区 ——
   * 而不是把代码贴在回答正文里等人复制。这是「智能体」与「聊天助手」的分界。
   */
  const [agentMode, setAgentMode] = usePersistentToggle("zhiyi-agent-mode");
  /** 智能体运行过程中的每一步,实时显示,免得几分钟里什么都看不到 */
  const [agentSteps, setAgentSteps] = useState<string[]>([]);
  /**
   * 智能体已运行毫秒数,由服务端心跳推送。
   *
   * 步与步之间可能隔几十秒(每一步都是一次非流式调用),只显示步骤的话
   * 那几十秒里界面完全静止,和卡死无法区分。
   */
  const [agentElapsed, setAgentElapsed] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** 桌面端历史栏是否展开。收起后输出区能多出 224px 宽度 */
  const [historyOpen, setHistoryOpen] = useState(true);

  /**
   * 连了几家服务商。
   *
   * 降级链只有跨**服务商**才真正起作用 —— 同一家的模型共用一个算力池,
   * 那家堵的时候换它自己的另一个模型等于没换。只有一家时必须明说,
   * 否则用户只会看到一次次超时,不知道系统其实无路可走。
   */
  const providerCount = new Set(models.map((m) => m.providerId)).size;

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
    setAgentSteps([]);
    setAgentElapsed(null);

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
          ...(webSearch ? { webSearch: true } : {}),
          ...(agentMode ? { agent: true } : {}),
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
      let reasoning = "";

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
            | {
                conversationId: string;
                model?: string;
                fallback?: string;
                trimming?: string;
                files?: number;
                search?: string;
              }
            | { text: string }
            | {
                index: number;
                text: string;
                tools: { name: string; ok: boolean; content: string }[];
              }
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
            // 上下文被裁剪时如实告知 —— 不说的话,用户只会觉得模型「忘了」
            if (payload.trimming) patchAssistant({ trimming: payload.trimming });
            // 联网与否必须如实显示 —— 否则用户无从判断这个回答是基于
            // 实时资料还是模型的旧知识
            if (payload.search) patchAssistant({ search: payload.search });
            if (typeof payload.files === "number") setContextFiles(payload.files);
          } else if (event === "delta" && "text" in payload) {
            text += payload.text;
            patchAssistant({ content: text });
          } else if (event === "reasoning" && "text" in payload) {
            reasoning += payload.text;
            patchAssistant({ reasoning });
          } else if (event === "done" && "latencyMs" in payload) {
            const done = payload as {
              inputTokens: number | null;
              outputTokens: number | null;
              latencyMs: number;
              messageId?: string;
            };
            patchAssistant({
              meta: {
                inputTokens: done.inputTokens,
                outputTokens: done.outputTokens,
                latencyMs: done.latencyMs,
              },
              // 真实 id 回填 —— 没有它反馈按钮点不动。
              // 落库失败时服务端不会带这个字段,那时按钮就不该出现。
              ...(done.messageId ? { dbId: done.messageId } : {}),
            });
          } else if (event === "step" && "index" in payload) {
            // 智能体每完成一步就推一条 —— 跑几分钟期间什么都不显示,
            // 用户只会以为卡死了
            const p = payload as {
              index: number;
              text: string;
              tools: { name: string; ok: boolean; content: string }[];
            };
            const line =
              p.tools.length > 0
                ? p.tools
                    .map((t) => `${t.ok ? "✓" : "✗"} ${t.content}`)
                    .join("\n")
                : p.text;
            if (line.trim() !== "") {
              setAgentSteps((prev) => [...prev, `第 ${p.index} 步:${line}`]);
            }
          } else if (event === "progress" && "elapsedMs" in payload) {
            // 智能体的每一步都是非流式调用,一步几十秒期间连接上什么都没有。
            // 显示已运行秒数,把「看起来卡死」变成「看得见在跑」。
            setAgentElapsed((payload as { elapsedMs: number }).elapsedMs);
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
    // 空状态必须能直接走下一步。
    //
    // 此前这里只有一句「请先到模型服务添加密钥」,既没有链接也没说去哪申请 ——
    // 新用户注册进来看到的就是一个说不清怎么办的死页面。
    // 说明「还差什么」的同时必须给出「怎么补」,否则等于把人挡在门外。
    return (
      <div className="font-zh mx-auto w-full max-w-2xl p-[18px]">
        <div className="border-border-default bg-surface-2 rounded-card border p-5">
          <p className="text-fg text-body mb-1 font-medium">还差一步:选一个模型服务</p>
          <p className="text-fg-secondary text-caption mb-4">
            智一 AI 不绑定任何一家服务商,模型由你自己接入 ——
            密钥加密存储、只在服务端解密,不会下发到浏览器。
          </p>

          <ol className="text-fg-secondary text-caption mb-4 flex flex-col gap-1.5 pl-4">
            <li className="list-decimal">
              去服务商官网申请一个 API 密钥。多家有免费额度,
              下面的预设里有官方文档直达链接。
            </li>
            <li className="list-decimal">
              到「模型服务」粘贴密钥并保存 —— 可用模型会自动导入。
            </li>
            <li className="list-decimal">回到这里就能开始对话。</li>
          </ol>

          <Link
            href="/settings/models"
            className={buttonClasses({ size: "sm" })}
          >
            <Icon name="settings" size={14} />
            去配置模型服务
          </Link>
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

        {/* ── 模块二:AI 助手 ──────────────────────────────
            对话与输入。与上面的「模型配置」分开,是因为两者的性质不同:
            一个是本次对话的前提(选完就不动),一个是持续的来回。 */}
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

                {/* 思考过程。放在答案上方,因为它先发生。
                    生成中默认展开 —— 那正是用户最需要看到「在动」的时刻;
                    生成完成后折叠起来,答案才是主角。 */}
                {turn.role === "assistant" && turn.reasoning ? (
                  <details
                    open={streaming && turn.content === ""}
                    className="border-divider bg-surface-2 rounded-control w-full border px-3 py-2"
                  >
                    <summary className="text-fg-tertiary text-label cursor-pointer select-none">
                      思考过程({turn.reasoning.length} 字)
                    </summary>
                    <div className="text-fg-tertiary text-label mt-2 max-h-64 overflow-auto whitespace-pre-wrap">
                      {turn.reasoning}
                    </div>
                  </details>
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
                  {linkify(turn.content)}
                  {turn.role === "assistant" &&
                    turn.content === "" &&
                    !turn.error &&
                    streaming && (
                      <span className="text-fg-tertiary">
                        {turn.reasoning ? "正在思考…" : "正在生成…"}
                      </span>
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

                {/* 用户自己写的长提示词同样需要复制 —— 常要改一版重发 */}
                {turn.content !== "" && (
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

                {/* 反馈只挂在**已落库**的助手消息上。
                    正在生成的那条还没有真实 id(前端用的是临时 id),
                    给它一个点了必然报「找不到这条消息」的按钮不如不给。

                    这是整条链路上唯一一件现在不做以后补不回来的事:
                    历史对话随时能回捞,但用户当时想把这句话改成什么,
                    过后没人记得。 */}
                {turn.role === "assistant" &&
                  turn.content !== "" &&
                  !turn.error &&
                  turn.dbId !== undefined && (
                    <MessageFeedback messageId={turn.dbId} />
                  )}
              </div>
            ))
          )}

          {/* 智能体运行进度。
              没有步骤时也要显示 —— 第一步返回之前可能就要等几十秒,
              那段时间恰恰是最容易被误判成卡死的。 */}
          {streaming && (agentSteps.length > 0 || agentElapsed !== null) && (
            <div className="border-border-default bg-surface-2 rounded-card mx-auto mt-4 w-full max-w-[900px] border p-3">
              <p className="text-fg-tertiary text-label mb-1.5">
                智能体运行中
                {agentElapsed !== null &&
                  ` · 已运行 ${Math.round(agentElapsed / 1000)} 秒`}
              </p>
              <pre className="text-fg-secondary text-label max-h-40 overflow-auto whitespace-pre-wrap">
                {agentSteps.length > 0
                  ? agentSteps.join("\n")
                  : "正在等待模型返回第一步…"}
              </pre>
            </div>
          )}
        </div>

        <form
          onSubmit={send}
          className="border-divider flex shrink-0 flex-col gap-2 border-t p-3.5"
        >
          {/* 只说结论,不说规则。
              取用规则那一长段搬到按钮的 title 里 —— 需要时悬停可见,
              不必每次都占掉输入区两行。 */}
          {!attachNote && contextFiles > 0 && (
            <p className="text-fg-secondary text-label">
              已关联 {contextFiles} 个项目文件
            </p>
          )}

          {attachNote && (
            <div className="border-border-default bg-surface-2 rounded-control flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="text-fg-secondary text-label">{attachNote}</span>
              {attachments.length > 0 && (
                <>
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

          {/* 控件全部用设计系统的原生组件,不自己拼装。

              Tag 本来就是「可点击的状态标签」:active 时填品牌色,
              可点击时渲染成真正的 button(键盘可达)。模式开关正是这个语义 ——
              此前我另写了一个 IconToggle,既重复了 Tag 的职责,
              开启态又只有一圈细边框,弱到用户分不清开没开。

              开着还是关着,看填色就知道;要关掉,再点一下同一个东西 ——
              不必另设一个「关闭」按钮,也不必在上方再挂一条状态带。 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              value={selected}
              onChange={setSelected}
              options={models.map((m) => ({
                value: m.value,
                label: `${m.providerName} · ${m.modelId}`,
              }))}
              className="text-caption min-h-8 min-w-0 max-w-[15rem] px-2.5 py-0"
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

            {/* 添加文件夹是一次性**动作**,不是模式 —— 用 IconButton,
                不能混进下面那两个 Tag 里,否则「点了会一直生效吗」说不清 */}
            <IconButton
              aria-label="添加文件夹"
              title={FOLDER_HINT}
              onClick={() => folderInputRef.current?.click()}
              size={32}
            >
              <Icon name="folder" size={15} />
            </IconButton>

            <Tag
              active={webSearch}
              onClick={() => setWebSearch((v) => !v)}
              className="gap-1.5"
            >
              <Icon name="search" size={13} />
              联网
            </Tag>

            <Tag
              active={agentMode}
              onClick={() => setAgentMode((v) => !v)}
              className="gap-1.5"
            >
              <Icon name="bot" size={13} />
              智能体
            </Tag>

            <div className="flex-1" />

            {/* 只连了一家服务商时,排队就无路可走。用 Badge —— 它是设计系统里
                表达状态的那个组件,不是我再画一个带图标的链接 */}
            {providerCount === 1 && (
              <Link href="/settings/models" title="只连了一家服务商。它排队或容量不足时,系统没有别家可以自动切换。">
                <Badge tone="warning">仅一家服务商</Badge>
              </Link>
            )}

            <Button
              type="submit"
              size="sm"
              loading={streaming}
              aria-label="发送"
              title="发送(Enter)"
              className="shrink-0 px-3"
            >
              <Icon name="send" size={15} />
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
