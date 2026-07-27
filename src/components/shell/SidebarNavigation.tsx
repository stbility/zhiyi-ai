"use client";

import { Icon, type IconName } from "@/components/icons/Icon";
import { Avatar } from "@/components/primitives/Avatar";
import { cn } from "@/lib/cn";

export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
}

/** 设计系统定义的导航结构。后续阶段新增入口时扩展这里,或由调用方传入 items。 */
export const DEFAULT_NAV: readonly NavItem[] = [
  { key: "today", label: "今日", icon: "today" },
  { key: "assistant", label: "AI 助手", icon: "assistant" },
  { key: "workflow", label: "工作流", icon: "workflow" },
  { key: "knowledge", label: "知识库", icon: "knowledge" },
  { key: "memory", label: "AI 记忆", icon: "memory" },
  { key: "search", label: "智能搜索", icon: "search" },
  { key: "reports", label: "报告", icon: "reports" },
  { key: "billing", label: "订阅", icon: "billing" },
  { key: "settings", label: "设置", icon: "settings" },
];

export interface SidebarAccount {
  name: string;
  planLabel: string;
  used: number;
  total: number;
}

export interface SidebarNavigationProps {
  activeKey?: string | undefined;
  onNavigate?: ((key: string) => void) | undefined;
  items?: readonly NavItem[] | undefined;
  /**
   * 账户信息。设计系统原实现给了一组默认假数据(姓名、套餐、额度),
   * 移植时移除 —— 未取到真实账户时如实显示「未登录」,不得用占位数字冒充额度。
   */
  account?: SidebarAccount | undefined;
  className?: string | undefined;
}

export function SidebarNavigation({
  activeKey = "today",
  onNavigate,
  items = DEFAULT_NAV,
  account,
  className,
}: SidebarNavigationProps) {
  const pct =
    account && account.total > 0
      ? Math.min(100, Math.round((account.used / account.total) * 100))
      : 0;

  return (
    <div
      className={cn(
        // shrink-0:侧边栏是固定 248px 的导航栏,不参与 flex 收缩
        "bg-surface-1 border-border-default font-zh w-sidebar flex h-full shrink-0 flex-col border-r",
        className,
      )}
    >
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
        <span
          aria-hidden
          className="bg-brand text-on-brand rounded-control flex size-7 items-center justify-center text-[14px] font-semibold"
        >
          智
        </span>
        <span className="text-fg text-body font-semibold">智一 AI</span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-3 py-1">
        {items.map((item) => {
          const active = item.key === activeKey;
          return (
            <button
              key={item.key}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onNavigate?.(item.key)}
              className={cn(
                "rounded-control flex cursor-pointer items-center gap-2.5 px-3 py-2.25 text-left text-[14px]",
                "transition-colors duration-[var(--duration-hover)] ease-standard",
                active
                  ? "bg-brand-tint text-brand"
                  : "text-fg-secondary hover:bg-surface-2",
              )}
            >
              <Icon name={item.icon} size={17} className="shrink-0" />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="border-divider flex flex-col gap-2.5 border-t p-4">
        {account ? (
          <>
            <p className="text-fg-tertiary text-label">
              {account.planLabel} · 使用额度
            </p>
            <div
              role="progressbar"
              aria-label="使用额度"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              className="bg-surface-3 h-1 overflow-hidden rounded-[2px]"
            >
              <div style={{ width: `${pct}%` }} className="bg-brand h-full" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <Avatar name={account.name} size={28} />
                <span className="text-fg text-[13px]">{account.name}</span>
              </span>
              <Icon name="helpCircle" size={16} className="text-fg-tertiary" />
            </div>
          </>
        ) : (
          <p className="text-fg-tertiary text-label">未登录</p>
        )}
      </div>
    </div>
  );
}
