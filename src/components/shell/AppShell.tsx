"use client";

import type { ReactNode } from "react";

import {
  AIAssistantPanel,
  type AIAssistantPanelProps,
} from "./AIAssistantPanel";
import {
  SidebarNavigation,
  type SidebarNavigationProps,
} from "./SidebarNavigation";
import { TopCommandBar } from "./TopCommandBar";

export interface AppShellProps {
  activeKey?: string | undefined;
  onNavigate?: ((key: string) => void) | undefined;
  title: string;
  onSearch?: (() => void) | undefined;
  account?: SidebarNavigationProps["account"] | undefined;
  navItems?: SidebarNavigationProps["items"] | undefined;
  assistantCollapsed?: boolean | undefined;
  onToggleAssistant?: (() => void) | undefined;
  assistantProps?: Omit<AIAssistantPanelProps, "collapsed" | "onToggle"> | undefined;
  children?: ReactNode | undefined;
}

/**
 * 应用外框:左侧导航 + 顶部命令栏 + 内容区 + 右侧 AI 助手。
 * 深色主题覆盖整个产品;浅色「纸张」画布只在文档阅读面内部出现,
 * 始终嵌套于此框架之中,不是独立的浅色应用。
 */
export function AppShell({
  activeKey,
  onNavigate,
  title,
  onSearch,
  account,
  navItems,
  assistantCollapsed = false,
  onToggleAssistant,
  assistantProps,
  children,
}: AppShellProps) {
  return (
    <div className="bg-canvas flex h-full w-full overflow-hidden">
      <SidebarNavigation
        activeKey={activeKey}
        onNavigate={onNavigate}
        items={navItems}
        account={account}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopCommandBar title={title} onSearch={onSearch} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>

      <AIAssistantPanel
        collapsed={assistantCollapsed}
        onToggle={onToggleAssistant}
        {...assistantProps}
      />
    </div>
  );
}
