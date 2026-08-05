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
import { Button } from "@/components/primitives/Button";
import { LinkButton } from "@/components/primitives/LinkButton";
import { IconButton } from "@/components/primitives/IconButton";
import { Select } from "@/components/primitives/Select";
import { Tag } from "@/components/primitives/Tag";
import {
  WorkspaceBrowser,
  type WorkspaceFile,
} from "@/components/app/WorkspaceBrowser";
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
  /**
   * 实测吞吐(token/秒),来自这个模型在本组织**真实跑过的调用**。
   *
   * 为什么要显示:用户反复问「为什么这么慢」,而慢的原因往往在服务商,
   * 不在模型本身。生产实测:同一个 deepseek-v4-flash,
   * 走 NVIDIA NIM 是 11 token/秒,走 DeepSeek 官方是 116 —— 差十倍。
   * 光看模型名完全分不出来。
   *
   * 把实测值摆在选项上,「让用户自己选择」才是可操作的 ——
   * 否则他只能凭名字猜,而名字不带这个信息。
   *
   * 样本不足时为 null:**不显示,也不猜**。一两次调用的均值没有意义,
   * 而一个编出来的数字比没有数字更糟。
   */
  throughput?: { tokensPerSec: number; samples: number } | null;
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
  /**
   * 这一轮跑过的工具,按发生顺序。只有智能体通道会有。
   *
   * 存的是**事实**:工具名、参数、成功与否、结果原文的开头。
   * 不存任何叙述。分界很清楚:一句由我们措辞、描述「它在跑」的话,
   * 是编的;而「write_file(src/app.tsx) 已写入 1240 字符」是发生过的事。
   */
  tools?: { name: string; ok: boolean; content: string }[];
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
  channel,
  workspace,
  models,
  conversations,
  activeConversationId,
  initialTurns,
}: {
  /**
   * 这个面板挂在哪条通道上。
   *
   * chat  —— AI 助手:单次流式生成,不碰工作区
   * agent —— 智能体:多步工具循环,产物写进工作区
   *
   * 此前这不是一个通道,是输入框里一个开关,状态还存在 localStorage 里。
   * 于是用户看不见自己处在哪种模式,每一句话都在悄悄走智能体;
   * 而服务端两条线共用一个端点,改一条弄坏另一条反复发生。
   *
   * 现在按 Claude 的分法拆开:两个页面、两个端点、两套限流。
   * 组件仍然共用,因为「渲染一段对话」这件事两边确实是同一件事 ——
   * 分开的是执行形态,不是消息列表长什么样。
   */
  channel: "chat" | "agent";
  /**
   * 这条会话的工作区产物。只有智能体通道会传。
   *
   * 用来给对话流里的工具行加一个触发:智能体写完 index.html,
   * 那一行可以点开 —— 全屏预览弹出来,Esc 关掉,**对话区一寸都不让**。
   *
   * 为什么是弹出层而不是右边一块常驻的栏:Claude Code 桌面版的预览
   * 就是需要时弹出来的,不是钉死在侧边。我按「钉死在右边」抄过两版,
   * 两版都把对话区挤窄了(第二版更窄,因为忘了侧栏本身就占 224px)。
   */
  workspace?: {
    id: string;
    name: string;
    files: readonly WorkspaceFile[];
  } | undefined;
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
  /**
   * 本轮是否联网。
   *
   * 由用户显式开启,不让模型自己决定 —— 模型判断「要不要搜」并不可靠,
   * 而每次搜索都消耗配额。显式开关让成本和行为都可预期。
   */
  const [webSearch, setWebSearch] = usePersistentToggle("zhiyi-web-search");
  /**
   * 本轮已等待的秒数,客户端本地计时。
   *
   * 不能只靠服务端心跳:那是智能体路径才有的,而**最需要它的恰恰是普通对话**。
   * 推理模型(deepseek-v4-pro 这类)会先思考很久才吐第一个正文字,
   * 而思考过程要服务商吐 reasoning_content 我们才显示得出来 ——
   * NVIDIA 的部署未必开着。于是界面上一两分钟一个字不动。
   *
   * 生产实测:一次带联网检索的提问,122 秒才出全文。
   * 中间什么都不显示,用户只能判断为「AI 助手无反应」,
   * 而它其实正常工作着,只是慢。
   */
  const [waitedMs, setWaitedMs] = useState(0);
  /**
   * 产物预览是否打开。
   *
   * 弹出层而不是常驻侧栏 —— 对话区一寸都不让。见 workspace 那个属性的说明。
   */
  const [previewOpen, setPreviewOpen] = useState(false);

  // 覆盖全屏的层必须能用 Esc 退出,否则键盘用户被困在里面,
  // 鼠标用户也会下意识按 Esc 然后发现没反应
  useEffect(() => {
    if (!previewOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewOpen]);

  // 归零放在 send() 里(事件处理器),不在 effect 体内直接 setState ——
  // 那会被 react-hooks/set-state-in-effect 挡下,而且确实是多余的一次渲染
  useEffect(() => {
    if (!streaming) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setWaitedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, [streaming]);
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
    setWaitedMs(0);

    const controller = new AbortController();
    abortRef.current = controller;

    const patchAssistant = (patch: Partial<Turn>) => {
      setTurns((prev) =>
        prev.map((t) => (t.id === assistantTurn.id ? { ...t, ...patch } : t)),
      );
    };

    try {
      // 通道决定端点。不再由请求体里一个布尔字段分岔 ——
      // 那种写法让「这次到底走的哪条线」只能靠读代码才知道。
      const response = await fetch(
        channel === "agent" ? "/api/agent" : "/api/chat",
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(conversationId ? { conversationId } : {}),
          providerId,
          model: modelId,
          content,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(webSearch ? { webSearch: true } : {}),
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
      let ranTools: { name: string; ok: boolean; content: string }[] = [];

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
          } else if (event === "step" && "tools" in payload) {
            // 智能体每完成一步就推一条。
            //
            // 只收工具执行,不收叙述:模型这一步说的话已经走 reasoning
            // 实时流出去了,再收一遍会重复。
            const p = payload as {
              tools: { name: string; ok: boolean; content: string }[];
            };
            if (p.tools.length > 0) {
              ranTools = [...ranTools, ...p.tools];
              patchAssistant({ tools: ranTools });
            }
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

  // 侧栏里的链接必须指回**本通道**。
  //
  // 这两处此前写死成 /assistant:在智能体页面点「新对话」或点任何一条
  // 历史记录,人就被悄悄送到 AI 助手去了 —— 而两条通道的执行形态完全不同。
  // 用户报的就是这个:「新对话点击跳转到 ai 助手的对话框」。
  const basePath = channel === "agent" ? "/agent" : "/assistant";

  // 侧栏沿用设计系统导航项的写法(SidebarNavigation):同样的圆角、间距、
  // 选中态 bg-brand-tint text-brand。自己另起一套样式正是「拼装感」的来源。
  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="px-3 pt-3 pb-2">
        <LinkButton
          href={`${basePath}?c=new`}
          onClick={() => setSidebarOpen(false)}
          variant="secondary"
          size="sm"
          className="w-full"
        >
          <Icon name="plus" size={14} />
          新对话
        </LinkButton>
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
                  href={`${basePath}?c=${c.id}`}
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
                  <Icon
                    name={channel === "agent" ? "bot" : "assistant"}
                    size={15}
                    className="shrink-0"
                  />
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

          <LinkButton href="/settings/models" size="sm">
            <Icon name="settings" size={14} />
            去配置模型服务
          </LinkButton>
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

                {/* 思考过程 —— 不套框。
                    照 Claude Code 的做法:思考以**灰色斜体**内联在流里流式显示,
                    默认折叠、可展开(它在终端里是 Ctrl+O)。

                    此前这里是一个带边框、带底色、带圆角的 details 盒子。
                    那个盒子把「模型在想」抬成了和答案并列的一块内容,
                    可它本来就不是内容 —— 是过程。灰斜体的意思正是
                    「这行字不是答案,扫一眼就够」。 */}
                {turn.role === "assistant" && turn.reasoning ? (
                  <details
                    open={streaming && turn.content === ""}
                    className="w-full [&_summary::-webkit-details-marker]:hidden"
                  >
                    <summary className="text-fg-tertiary text-label hover:text-fg-secondary cursor-pointer list-none italic select-none">
                      ✻ 思考过程
                    </summary>
                    {/* 左边一条细线代替边框:既标出这段的范围,
                        又不把它围成一个与答案平级的方块 */}
                    <div className="border-divider text-fg-tertiary text-label mt-1.5 max-h-64 overflow-auto border-l pl-3 italic whitespace-pre-wrap">
                      {turn.reasoning}
                    </div>
                  </details>
                ) : null}

                {/* 工具执行 —— 照 Claude Code 的做法用**专门的可视组件**
                    呈现,而不是把它拼成一段话混进回答里。
                    每一行都是发生过的事:调了哪个工具、结果是什么。
                    这里一个字的叙述都没有。 */}
                {turn.tools && turn.tools.length > 0 ? (
                  <ul className="flex w-full flex-col gap-1">
                    {turn.tools.map((t, i) => {
                      // 成功写入的那一行可以点开 —— 产物就在工作区里,
                      // 点一下全屏看,不必切页面去找。
                      // 工作区还没取到(刚写完、页面尚未刷新)时不给点,
                      // 点开一个空层比不能点更糟。
                      const 可预览 =
                        t.ok &&
                        t.name === "write_file" &&
                        (workspace?.files.length ?? 0) > 0;
                      const 行 = (
                        <>
                          <Icon
                            name={t.ok ? "check" : "x"}
                            size={12}
                            className={cn(
                              "mt-1 shrink-0",
                              t.ok ? "text-success" : "text-error",
                            )}
                          />
                          <span className="min-w-0 flex-1 text-left">
                            <code className="text-fg-secondary text-label font-mono">
                              {t.name}
                            </code>
                            <span className="text-fg-tertiary text-label ml-2 break-all">
                              {t.content}
                            </span>
                          </span>
                        </>
                      );
                      return (
                        <li key={i}>
                          {可预览 ? (
                            <button
                              type="button"
                              onClick={() => setPreviewOpen(true)}
                              title="打开预览"
                              className="hover:bg-surface-2 rounded-control -mx-1.5 flex w-[calc(100%+0.75rem)] cursor-pointer items-start gap-2 border-0 bg-transparent px-1.5 py-0.5 text-left transition-colors duration-[var(--duration-hover)] ease-standard"
                            >
                              {行}
                            </button>
                          ) : (
                            <span className="flex items-start gap-2 px-1.5 py-0.5">
                              {行}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
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
                        {turn.reasoning ? "正在思考" : "正在生成"}
                        {waitedMs >= 1000 && ` · 已等待 ${Math.round(waitedMs / 1000)} 秒`}
                        {/* 这里曾挂过一段「推理模型会先思考很久……想更快可以
                            换 X 或关掉联网」的建议。删掉了:界面不是替用户
                            出主意的地方,而且那段话是我的推断,不是事实。
                            秒数在动本身已经说明它在跑。 */}
                      </span>
                    )}
                </div>

                {/* 这里曾显示「本次回复改用了 X」这类系统说明。
                    不再显示 —— 用户明确要求界面上不要出现我生成的说明性文字。
                    事实仍然完整留痕:messages.model_id 记的是**实际用上的**
                    那个模型,查得到,只是不再往回答旁边贴一句解释。 */}
                {turn.error && (
                  <p className="text-error text-label">{turn.error}</p>
                )}

                {/* 用户自己写的长提示词同样需要复制 —— 常要改一版重发 */}
                {turn.content !== "" && (
                  <div className="flex flex-wrap items-center gap-3">
                    <CopyButton text={turn.content} />
                    {/* 反馈并进同一条操作行 —— 参考 Claude:赞/踩与「复制」
                        同尺寸、同灰度、同 hover。此前它单独占一行,
                        三个动作横在回答下面比回答本身还抢眼 */}
                    {turn.role === "assistant" &&
                      !turn.error &&
                      turn.dbId !== undefined && (
                        <MessageFeedback messageId={turn.dbId} />
                      )}
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
              </div>
            ))
          )}

          {/* 这里曾经挂着一块由我们措辞的运行状态板 —— 报运行秒数、
              报「还在等第一步」。删掉了,那是系统在旁白。

              跑起来还看得见吗?看得见,而且看到的都是真实发生的东西:
              思考过程走 reasoning 事件实时流出,上面那段灰斜体就在动;
              工具执行走 step 事件,渲染成上面那组结构化的工具行;
              等待秒数由客户端本地计时(waitedMs),不是服务端推的文案;
              产物在智能体页面右边那一栏里,实时看得见。

              progress 事件仍然收着但不渲染 —— 它是心跳,
              没有它中间的反向代理会因为长时间无数据把连接掐断。 */}
        </div>

        <form
          onSubmit={send}
          className="border-divider flex shrink-0 flex-col gap-2 border-t p-3.5"
        >
          {/* 只说结论,不说规则。
              取用规则那一长段搬到按钮的 title 里 —— 需要时悬停可见,
              不必每次都占掉输入区两行。 */}
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
          {/* 底部工具条的分区照 Claude 的 composer:
              **左边是行为开关**(附件、联网 —— 这一轮怎么做),
              **右边是「谁来回答」**(模型选择)加发送。
              官方的说法是「+ on the left and model on the right keep
              behavioral toggles separate from which model answers」——
              把工具选择和模型选择分开,免得两者互相抢注意力。

              此前模型选择框排在最左边,和文件夹、联网挤成一排,
              四个东西谁也不比谁重要,反而看不出哪个决定了什么。

              控件一律用设计系统的原生组件,不自己拼装:
              Tag 本来就是「可点击的状态标签」(active 填品牌色、
              可点击时渲染成真 button),模式开关正是这个语义;
              添加文件夹是一次性**动作**不是模式,所以用 IconButton。 */}
          <div className="flex flex-wrap items-center gap-1.5">
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

            <div className="flex-1" />

            <Select
              value={selected}
              onChange={setSelected}
              options={models.map((m) => ({
                value: m.value,
                // 吞吐是**实测值**,没有样本就不写 —— 不猜、不留空占位
                label: m.throughput
                  ? `${m.providerName} · ${m.modelId}(实测 ${m.throughput.tokensPerSec} token/秒,${m.throughput.samples} 次)`
                  : `${m.providerName} · ${m.modelId}`,
              }))}
              className="text-caption min-h-8 min-w-0 max-w-[15rem] px-2.5 py-0"
            />

            {/* 发送按钮**有东西可发才出现**。
                Claude 的做法:「The send button appears only once there is
                something to ship」—— 用出现与否本身当作「这条可以发了」的
                信号。生成中要留着,那时它是「停止」的位置。 */}
            {(draft.trim() !== "" || streaming) && (
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
            )}
          </div>
        </form>
      </div>

      {/* 产物预览。**弹出层,不是常驻侧栏。**
          Claude Code 桌面版的预览就是需要时弹出来的 —— 我按「钉死在右边」
          抄过两版,两版都在从对话区里割肉(第二版更窄,因为忘了会话侧栏
          本身就占 224px)。弹出层的好处很直接:对话区一寸都不让。

          里面装的就是「工作区」页面那个 WorkspaceBrowser,原样复用 ——
          文件列表、HTML 预览、源码、下载全在里面,不另起一套。 */}
      {previewOpen && workspace && (
        <div
          className="bg-canvas/90 fixed inset-0 z-100 flex flex-col p-4 md:p-8"
          role="dialog"
          aria-modal
          aria-label="工作区产物"
        >
          <div className="mb-2 flex shrink-0 items-center justify-end">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setPreviewOpen(false)}
            >
              <Icon name="x" size={14} />
              关闭(Esc)
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WorkspaceBrowser
              id={workspace.id}
              name={workspace.name}
              files={workspace.files}
            />
          </div>
        </div>
      )}
    </div>
  );
}
