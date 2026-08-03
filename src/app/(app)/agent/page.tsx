import type { Metadata } from "next";
import Link from "next/link";

import { ChatPanel } from "@/components/app/ChatPanel";
import { WorkspaceBrowser } from "@/components/app/WorkspaceBrowser";
import {
  loadConversations,
  loadModels,
  loadTurns,
  loadWorkspaceForConversation,
} from "@/lib/db/conversations";
import { getMyOrganizations } from "@/lib/db/queries";

/**
 * 智能体 —— 干成一件事。
 *
 * 与 AI 助手的分界线不是「更强的对话」,是**有副作用**:模型会连续调用
 * 文件工具,产物直接写进工作区,而不是把代码贴在回答正文里等人复制。
 * 贴在正文里的东西还要手工复制粘贴,那等于没做。
 *
 * 页面是**两栏**的,这一点很要紧:左边是过程,右边是产物。
 *
 * 此前这个页面只是把 AI 助手的面板原样搬过来 —— 同样的气泡、同样的
 * 输入框,没有工作区、没有文件列表、没有步骤显示。后端确实走的是
 * 另一条通道,但用户在界面上没有任何办法分辨,于是合理的怀疑就是
 * 「这页面是复制的、在冒充智能体」。那个怀疑是对的:一个连产出物
 * 都不展示的页面,凭什么叫智能体工作台。
 *
 * 三条纪律,都是被真实故障逼出来的:
 *   1. 模型不换 —— 你选哪个就跑哪个
 *   2. 界面上不出现系统写的旁白 —— 只有模型的话和发生过的事
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

  const [initialTurns, workspace] = active
    ? await Promise.all([
        loadTurns(active.id),
        loadWorkspaceForConversation(active.id),
      ])
    : [[], null];

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex min-w-0 flex-1 overflow-hidden">
        <ChatPanel
          key={active?.id ?? "new"}
          channel="agent"
          models={models}
          conversations={conversations}
          activeConversationId={active?.id ?? null}
          initialTurns={initialTurns}
        />
      </div>

      {/* 产物栏。
          窄屏隐藏 —— 手机上两栏谁都读不清,产物在「工作区」页面照样看得到。
          ChatPanel 跑完一轮会 router.refresh(),这一栏跟着刷新。 */}
      <aside className="border-divider hidden w-[380px] shrink-0 flex-col overflow-y-auto border-l xl:flex">
        {workspace ? (
          <div className="p-3">
            <WorkspaceBrowser
              id={workspace.id}
              name={workspace.name}
              files={workspace.files}
            />
          </div>
        ) : (
          <div className="p-4">
            <p className="text-fg-tertiary text-label">
              这条会话还没有产出文件。
            </p>
            {/* 到此为止。不在后面追一句撺掇用户去用它的话 ——
                界面不是我们给用户出主意的地方,而且「还没有产出」
                本来就是一个正常状态,不需要解释,更不需要推销。 */}
          </div>
        )}
      </aside>
    </div>
  );
}
