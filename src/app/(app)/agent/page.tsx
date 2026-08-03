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
 * 页面是**两块平铺的窗格**:左边是过程,右边是产物。
 *
 * 布局照 Claude Code 桌面版:它是一套可平铺的窗格(chat / file / preview /
 * diff),文件树**持续可见并随智能体创建文件实时更新**,预览窗格
 * 直接渲染 HTML —— 产物看得见摸得着,不用切到别处去找。
 *
 * 有一条是踩出来的:**没有产物时不留空窗格**。此前右边固定挂一个
 * 380px 的框,工作区是空的时候就是一大块白,既没信息又把对话挤窄。
 * 现在没有文件就整幅让给对话,有了文件才平铺成两块。
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

  // 有产物才平铺成两块。
  //
  // 没有产物时右边那一块是纯粹的空白 —— 它不提供任何信息,只是把对话
  // 挤窄。空工作区本来就是正常状态(工作区是用到时才建的),
  // 不需要用一个框去宣告它。
  const 有产物 = workspace !== null && workspace.files.length > 0;

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

      {/* 产物窗格。与对话等宽平铺,不是挂在边上的一条。
          用的是「工作区」页面同一个 WorkspaceBrowser —— 文件列表、
          HTML 预览、源码、全屏都在里面,不另起一套。
          窄屏不平铺:一块屏放两栏谁都读不清,产物在「工作区」页面照样看得到。
          ChatPanel 跑完一轮会 router.refresh(),这一栏跟着刷新。 */}
      {有产物 && workspace ? (
        <aside className="border-divider hidden min-w-0 flex-1 overflow-y-auto border-l p-4 xl:block">
          <WorkspaceBrowser
            id={workspace.id}
            name={workspace.name}
            files={workspace.files}
          />
        </aside>
      ) : null}
    </div>
  );
}
