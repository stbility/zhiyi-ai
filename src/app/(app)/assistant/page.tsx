import type { Metadata } from "next";
import Link from "next/link";

import { ChatPanel } from "@/components/app/ChatPanel";
import {
  loadConversations,
  loadModels,
  loadTurns,
} from "@/lib/db/conversations";
import { getCurrentOrganization } from "@/lib/db/queries";

/**
 * AI 助手 —— 想清楚一件事。
 *
 * 这个页面**不碰工作区**:模型只输出文本,不调用文件工具,不产生副作用。
 * 要动真格的去 /agent。
 *
 * 这是 Claude 的分法:claude.ai 是思考伙伴,Claude Code 是工程师,
 * 两个真正不同的产品。此前这两件事挤在同一个页面里,靠输入框上一个
 * 存在 localStorage 的开关切换 —— 用户看不见自己在哪个模式,
 * 而服务端两条线共用一个端点,改一条弄坏另一条反复发生。
 */

export const metadata: Metadata = { title: "AI 助手 · 智一 AI" };
export const dynamic = "force-dynamic";

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
    const org = await getCurrentOrganization();

  if (!org) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">AI 助手</h2>
        <p className="text-fg-secondary font-zh text-caption">
          需要先创建组织。模型服务与对话记录都归属于组织。
        </p>
        <Link
          href="/today"
          className="text-brand hover:text-brand-hover font-zh text-caption mt-3 inline-block"
        >
          前往创建组织
        </Link>
      </div>
    );
  }

  const [models, conversations] = await Promise.all([
    loadModels(org.id),
    loadConversations(org.id, "chat"),
  ]);

  // 打开指定对话;没指定就接着最近一次继续 —— 用户回来通常是想接着上次说。
  // c=new 表示明确要开新的,此时不能回落到最近一条,否则「新对话」等于没反应。
  const requested = (await searchParams).c;
  const active =
    requested === "new"
      ? null
      : (conversations.find((c) => c.id === requested) ??
        conversations[0] ??
        null);
  const initialTurns = active ? await loadTurns(active.id) : [];

  return (
    // 对话页占满整屏:页面本身不滚动,只有消息区滚动。
    // 原先是 mx-auto max-w-5xl + 页面整体滚动,两侧留白吃掉大量横向空间,
    // 长回复还要跟着页面一起滚 —— 屏幕再大也显得局促。
    <div className="flex h-full w-full overflow-hidden">
      <ChatPanel
        // 切换对话时直接重挂组件,由初始 state 载入新数据 ——
        // 比在 effect 里同步 state 干净,也不会引起级联渲染
        key={active?.id ?? "new"}
        channel="chat"
        models={models}
        conversations={conversations}
        activeConversationId={active?.id ?? null}
        initialTurns={initialTurns}
      />
    </div>
  );
}
