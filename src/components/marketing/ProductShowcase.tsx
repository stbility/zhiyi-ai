import { WorkflowCard } from "@/components/workflow/WorkflowCard";

/**
 * 首屏产品视觉 —— 用真实的产品组件搭出产品界面本身,而不是抽象插画。
 *
 * 卡片内容是产品能力的示意,措辞上不声称是任何客户的真实数据。
 * 这里用的是与产品内完全相同的 WorkflowCard 组件,所以官网展示的界面
 * 与实际产品一致,不存在「官网好看、产品是另一回事」的落差。
 */
export function ProductShowcase() {
  return (
    <div className="border-border-default bg-surface-1 shadow-flyout rounded-panel overflow-hidden border">
      {/* 窄屏隐藏左右两栏,只保留主内容 —— 三栏工作区在手机上会把卡片挤成一字一行 */}
      <div className="flex h-auto md:h-120">
        <div className="border-border-default font-zh hidden w-50 shrink-0 flex-col gap-1 border-r p-4 md:flex">
          {["今日", "AI 助手", "工作流", "知识库", "AI 记忆"].map(
            (label, index) => (
              <span
                key={label}
                className={
                  index === 2
                    ? "bg-brand-tint text-brand rounded-control px-2.5 py-2 text-[13px]"
                    : "text-fg-tertiary rounded-control px-2.5 py-2 text-[13px]"
                }
              >
                {label}
              </span>
            ),
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3.5 p-6">
          <p className="text-fg font-zh text-h3 font-medium">工作流</p>
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
        </div>

        <div className="border-border-default font-zh hidden w-65 shrink-0 border-l p-4 xl:block">
          <p className="text-fg-tertiary mb-2.5 text-[11px]">
            AI 助手 · 当前上下文
          </p>
          <p className="bg-surface-2 border-border-default text-fg-secondary rounded-[10px] border p-3 text-[13px] leading-[1.6]">
            已根据知识库生成初稿,等待确认三处关键假设。
          </p>
        </div>
      </div>
    </div>
  );
}
