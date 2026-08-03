import type { Metadata } from "next";
import Link from "next/link";

import { ChatPanel } from "@/components/app/ChatPanel";
import {
  loadConversations,
  loadModels,
  loadTurns,
} from "@/lib/db/conversations";
import { getMyOrganizations } from "@/lib/db/queries";

/**
 * 智能体 —— 干成一件事。
 *
 * 与 AI 助手的分界线不是「更强的对话」,是**有副作用**:模型会连续调用
 * 文件工具,产物直接写进工作区,而不是把代码贴在回答正文里等人复制。
 * 贴在正文里的东西还要手工复制粘贴,那等于没做。
 *
 * 页面单独成一条通道(而不是输入框上一个开关),照的是 Claude 的分法:
 * claude.ai 是思考伙伴,Claude Code 是工程师 —— 两个真正不同的产品,
 * 默认能力面完全不同。
 *
 * 三条纪律,都是被真实故障逼出来的:
 *   1. 模型不换 —— 你选哪个就跑哪个。自动降级会让留痕和界面互相矛盾
 *   2. 界面上不出现系统写的旁白 —— 对话框里只有模型自己的话
 *   3. 除平台强制的 300 秒外没有任何人为时限
 */

export const metadata: Metadata = { title: "智能体 · 智一 AI" };
export const dynamic = "force-dynamic";

export default async function AgentPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const organizations = await getMyOrganizations();
  const org = organizations[0];

  if (!org) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">智能体</h2>
        <p className="text-fg-secondary font-zh text-caption">
          需要先创建组织。模型服务、工作区与运行记录都归属于组织。
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
    // 只列智能体这条通道的会话。用户来这个页面是想接着昨天那个没跑完的
    // 任务,不是想翻昨天问过的概念题。见迁移 0023。
    loadConversations(org.id, "agent"),
  ]);

  const requested = (await searchParams).c;
  const active =
    requested === "new"
      ? null
      : (conversations.find((c) => c.id === requested) ??
        conversations[0] ??
        null);
  const initialTurns = active ? await loadTurns(active.id) : [];

  return (
    <div className="flex h-full w-full overflow-hidden">
      <ChatPanel
        key={active?.id ?? "new"}
        channel="agent"
        models={models}
        conversations={conversations}
        activeConversationId={active?.id ?? null}
        initialTurns={initialTurns}
      />
    </div>
  );
}
