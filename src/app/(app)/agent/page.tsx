import type { Metadata } from "next";
import Link from "next/link";

import { ChatPanel } from "@/components/app/ChatPanel";
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
 * 页面是**整幅单栏**的:对话占满可用宽度,右边不挂任何东西。
 *
 * 这里我连着做错了两版,记下来免得再犯:
 *
 *   第一版  右边固定挂 380px 的产物栏。工作区为空时就是一大块白,
 *           既没信息又把对话挤窄。
 *   第二版  改成「有产物才平铺成两块等宽窗格」。看着讲得通,算术却更糟:
 *           ChatPanel 里面还有一个 224px 的会话侧栏,于是 1512px 的屏上
 *           对话区只剩 1512×0.5 − 224 = 532px,比第一版的 908px
 *           还窄了 41%。我为了修一个窄框,做出了一个更窄的框。
 *
 * 教训是那个 224px:Claude Code 桌面版是**三块各自独立的窗格**
 * (会话列表 / 对话 / 预览),不是「两块、其中一块自带侧栏」。
 * 在没有把会话列表拆成独立窗格之前,任何右侧栏都是在从对话区里割肉。
 *
 * 所以产物不在这个页面上展示,而是:
 *   · 每一步写了哪个文件,由对话流里的工具行如实列出(发生过的事)
 *   · 文件本身在左侧导航的「工作区」里看,那里是整幅的
 * 等会话列表拆成独立窗格之后,再谈把预览搬回来。
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
        // 产物不铺在页面上,只在**点开时**弹出来 —— 见 ChatPanel 的
        // workspace 属性说明。所以这里只是把文件取来备用,
        // 不占页面上任何宽度。
        loadWorkspaceForConversation(active.id),
      ])
    : [[], null];

  return (
    // 和 AI 助手页面同一种外壳:整幅、不滚动,只有消息区滚动。
    // 右边不挂任何东西 —— 见文件头那段关于 224px 的教训。
    <div className="flex h-full w-full overflow-hidden">
      <ChatPanel
        key={active?.id ?? "new"}
        channel="agent"
        {...(workspace ? { workspace } : {})}
        models={models}
        conversations={conversations}
        activeConversationId={active?.id ?? null}
        initialTurns={initialTurns}
      />
    </div>
  );
}
