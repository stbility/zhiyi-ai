"use client";

import { useState } from "react";

import { Icon, type IconName } from "@/components/icons/Icon";
import { KnowledgeFileRow } from "@/components/knowledge/KnowledgeFileRow";
import { MemoryCard } from "@/components/memory/MemoryCard";
import { DailyBriefCard } from "@/components/dashboard/DailyBriefCard";
import { WorkflowCard } from "@/components/workflow/WorkflowCard";
import { WorkflowTimeline } from "@/components/workflow/WorkflowTimeline";
import { cn } from "@/lib/cn";

/**
 * 首屏产品展示 —— 可点击切换的真实界面,不是截图。
 *
 * 左侧导航可点,右侧内容随之切换,用的是产品内完全相同的组件。
 * 这样官网展示的界面与实际产品一致,不存在「官网好看、产品是另一回事」的落差,
 * 也让访客在注册前就能真实感受到这是一个操作系统而非一篇文档。
 *
 * 内容是产品能力的示意,措辞上不声称是任何客户的真实数据。
 */

type ScreenKey = "today" | "workflow" | "knowledge" | "memory";

const NAV: readonly { key: ScreenKey; label: string; icon: IconName }[] = [
  { key: "today", label: "今日", icon: "today" },
  { key: "workflow", label: "工作流", icon: "workflow" },
  { key: "knowledge", label: "知识库", icon: "knowledge" },
  { key: "memory", label: "AI 记忆", icon: "memory" },
];

const TITLE: Record<ScreenKey, string> = {
  today: "今日",
  workflow: "工作流",
  knowledge: "知识库",
  memory: "AI 记忆",
};

function TodayScreen() {
  return (
    <DailyBriefCard
      date="2026年7月27日 周一"
      greeting="早上好"
      priorities={["确认季度报告的三处关键假设", "处理知识库中解析失败的文件"]}
      runningWorkflows={[
        { id: "w1", name: "季度经营分析报告", status: "WAITING_FOR_APPROVAL" },
        { id: "w2", name: "竞品调研简报", status: "RUNNING" },
      ]}
      pendingConfirmations={["季度报告初稿", "竞品调研摘要"]}
      className="max-w-none"
    />
  );
}

function WorkflowScreen() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        <WorkflowCard
          name="季度经营分析报告"
          goal="汇总三个部门数据并生成分析结论"
          status="WAITING_FOR_APPROVAL"
          currentStep="确认关键假设"
          agents={["研究", "写作"]}
          lastRun="09:41"
        />
        <WorkflowCard
          name="竞品调研简报"
          goal="追踪三家竞品的定价与功能变化"
          status="RUNNING"
          currentStep="生成对比表"
          agents={["研究"]}
          lastRun="08:55"
        />
      </div>
      <div className="border-border-default rounded-card border p-4">
        <WorkflowTimeline
          steps={[
            { id: "1", title: "收集三个部门数据", status: "COMPLETED", agent: "研究", timestamp: "09:12" },
            { id: "2", title: "生成分析初稿", status: "COMPLETED", agent: "写作", timestamp: "09:38" },
            { id: "3", title: "确认关键假设", status: "WAITING_FOR_APPROVAL" },
            { id: "4", title: "导出报告", status: "DRAFT" },
          ]}
        />
      </div>
    </div>
  );
}

function KnowledgeScreen() {
  return (
    <div className="border-border-default rounded-card overflow-hidden border">
      <KnowledgeFileRow name="2026 Q2 财务附表.pdf" type="PDF" size="2.4 MB" status="ready" linkedWorkflows={3} tags={["财务"]} />
      <KnowledgeFileRow name="部门访谈纪要.docx" type="DOCX" size="1.1 MB" status="ready" linkedWorkflows={1} />
      <KnowledgeFileRow name="竞品定价页存档.md" type="MD" size="24 KB" status="indexing" />
      <KnowledgeFileRow name="会议录音转写.txt" type="TXT" size="8 KB" status="failed" />
    </div>
  );
}

function MemoryScreen() {
  return (
    <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
      <MemoryCard
        category="写作风格"
        content="偏好简洁、少用感叹号的商务中文写作风格。"
        source="inferred"
        createdAt="2026-06-02"
        lastUsedAt="2 小时前"
        confidence={82}
        scope="全部工作流"
      />
      <MemoryCard
        category="已确认事实"
        content="季度报告的口径以财务部提供的附表为准。"
        source="confirmed"
        createdAt="2026-05-11"
        lastUsedAt="昨天"
        scope="季度报告工作流"
      />
    </div>
  );
}

const SCREEN: Record<ScreenKey, () => React.ReactElement> = {
  today: TodayScreen,
  workflow: WorkflowScreen,
  knowledge: KnowledgeScreen,
  memory: MemoryScreen,
};

export function ProductShowcase() {
  const [active, setActive] = useState<ScreenKey>("workflow");
  const Screen = SCREEN[active];

  return (
    <div className="border-border-default bg-surface-1 shadow-flyout rounded-panel overflow-hidden border text-left">
      <div className="flex min-h-120 flex-col md:flex-row">
        {/* 窄屏改为横向标签条,避免三栏在手机上把内容挤成一字一行 */}
        <nav
          aria-label="产品界面切换"
          className="border-border-default flex shrink-0 gap-1 overflow-x-auto border-b p-3 md:w-50 md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-4"
        >
          {NAV.map((item) => {
            const isActive = item.key === active;
            return (
              <button
                key={item.key}
                type="button"
                aria-current={isActive ? "true" : undefined}
                onClick={() => setActive(item.key)}
                className={cn(
                  // 窄屏放大到 44px,满足移动端可靠点击;桌面回到紧凑的 36px
                  "rounded-control font-zh flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-[13px] whitespace-nowrap md:min-h-9 md:px-2.5",
                  "transition-colors duration-[var(--duration-hover)] ease-standard",
                  "focus-visible:outline-border-focus focus-visible:outline-2 focus-visible:outline-offset-2",
                  isActive
                    ? "bg-brand-tint text-brand"
                    : "text-fg-tertiary hover:bg-surface-2 hover:text-fg-secondary",
                )}
              >
                <Icon name={item.icon} size={15} className="shrink-0" />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-3.5 p-5 md:p-6">
          <p className="text-fg font-zh text-h3 font-medium">{TITLE[active]}</p>
          {/* key 让切换时重新挂载,内容以 220ms 淡入 —— 仅透明度,无位移无缩放 */}
          <div
            key={active}
            className="animate-screen-enter flex flex-col gap-3.5"
          >
            <Screen />
          </div>
        </div>
      </div>
    </div>
  );
}
