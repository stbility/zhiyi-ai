"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { ThemeToggle } from "@/components/app/ThemeToggle";
import { Icon, type IconName } from "@/components/icons/Icon";
import { IconButton } from "@/components/primitives/IconButton";
import { Avatar } from "@/components/primitives/Avatar";
import { cn } from "@/lib/cn";

/**
 * 登录后的应用外框。
 *
 * 响应式策略:
 *   桌面 —— 固定 248px 侧边导航常驻。
 *   窄屏 —— 侧边栏收进抽屉,顶部换为带菜单按钮的紧凑栏。
 *           248px 侧栏 + 360px 助手面板在 375px 屏上根本放不下,
 *           硬塞的结果是内容被压成一字一行。
 *
 * 导航项分两类:已交付的可点击跳转;未交付的显式标注「建设中」并禁用 ——
 * 让用户点进一个 404 页面,和放一个空按钮是同一类问题。
 */

export interface NavEntry {
  key: string;
  label: string;
  icon: IconName;
  href: string;
  /** 尚未交付的模块:显示但不可点击,并如实说明 */
  available: boolean;
}

export const APP_NAV: readonly NavEntry[] = [
  { key: "today", label: "今日", icon: "today", href: "/today", available: true },
  { key: "assistant", label: "AI 助手", icon: "assistant", href: "/assistant", available: true },
  // 智能体单独一条通道,不是 AI 助手里的一个开关。
  // 两者的执行形态完全不同:一个只说话,一个动工作区。见 /api/agent。
  { key: "agent", label: "智能体", icon: "bot", href: "/agent", available: true },
  { key: "workspace", label: "工作区", icon: "book", href: "/workspace", available: true },
  { key: "workflow", label: "工作流", icon: "workflow", href: "/workflow", available: false },
  { key: "knowledge", label: "知识库", icon: "knowledge", href: "/knowledge", available: false },
  { key: "memory", label: "AI 记忆", icon: "memory", href: "/memory", available: false },
  { key: "integrations", label: "集成", icon: "link", href: "/settings/integrations", available: true },
  { key: "settings", label: "模型服务", icon: "settings", href: "/settings/models", available: true },
];

export interface AppChromeProps {
  displayName: string;
  organizationName: string | null;
  children: ReactNode;
}

export function AppChrome({
  displayName,
  organizationName,
  children,
}: AppChromeProps) {
  const pathname = usePathname();

  // 顶栏标题由当前路由推导。此前由布局写死成「今日」,于是每个页面顶部
  // 都显示「今日」—— 在 AI 助手页尤其明显,顶栏说「今日」、内容是对话,
  // 看起来就像两个不相干的组件拼在一起。
  const title =
    APP_NAV.find((item) => pathname.startsWith(item.href))?.label ?? "智一 AI";
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 抽屉打开时锁滚动,并支持 Esc 关闭
  useEffect(() => {
    if (!drawerOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);

    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  const nav = (
    <nav aria-label="主导航" className="flex flex-1 flex-col gap-0.5 px-3 py-1">
      {APP_NAV.map((item) => {
        const active = pathname === item.href;

        if (!item.available) {
          return (
            <span
              key={item.key}
              title="该模块尚未交付"
              className="rounded-control text-fg-disabled flex cursor-not-allowed items-center gap-2.5 px-3 py-2.25 text-[14px]"
            >
              <Icon name={item.icon} size={17} className="shrink-0" />
              <span className="flex-1">{item.label}</span>
              <span className="text-label border-border-default rounded-tag border px-1.5">
                建设中
              </span>
            </span>
          );
        }

        return (
          // 必须是真正的链接,不能是 button + router.push。
          //
          // 这是「导航按钮要点很多下才生效」的根因,有三层:
          //   1. 水合完成前 <button onClick> 完全是死的 —— 事件还没挂上。
          //      <Link> 渲染成 <a href>,零 JavaScript 也能跳。
          //   2. <Link> 会预取目标页面;router.push 是点击那一刻才开始请求。
          //      这些页面是 force-dynamic,一次要跑好几个数据库查询 ——
          //      点下去一两秒内屏幕毫无变化,用户当然会再点。
          //   3. 中键、Cmd+点击、右键「在新标签页打开」在 button 上全部失效。
          <Link
            key={item.key}
            href={item.href}
            aria-current={active ? "page" : undefined}
            // 关抽屉发生在用户点击这一刻,而不是「观察到路由变了再补关闭」——
            // 后者是把用户操作的结果当成需要同步的外部状态,会触发级联渲染
            onClick={() => setDrawerOpen(false)}
            className={cn(
              "rounded-control flex cursor-pointer items-center gap-2.5 px-3 py-2.25 text-left text-[14px]",
              "transition-colors duration-[var(--duration-hover)] ease-standard",
              "focus-visible:outline-border-focus focus-visible:outline-2 focus-visible:outline-offset-2",
              active
                ? "bg-brand-tint text-brand"
                : "text-fg-secondary hover:bg-surface-2",
            )}
          >
            <Icon name={item.icon} size={17} className="shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  const sidebarBody = (
    <>
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
        <span
          aria-hidden
          className="bg-brand text-on-brand rounded-control flex size-7 items-center justify-center text-[14px] font-semibold"
        >
          智
        </span>
        <span className="text-fg text-body font-semibold">智一 AI</span>
      </div>

      {nav}

      <div className="border-divider flex flex-col gap-2 border-t p-4">
        {/* 组织名不再单独占一行 —— 单人使用时它就是个重复的产品名,
            只在真的没加入组织时提示一次(那是需要用户处理的状态) */}
        {organizationName === null && (
          <p className="text-fg-tertiary text-label">尚未加入组织</p>
        )}
        <div className="flex items-center gap-2">
          <Avatar name={displayName} size={28} />
          <span className="text-fg truncate text-[13px]">{displayName}</span>
        </div>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="text-fg-tertiary hover:text-fg-secondary text-label cursor-pointer transition-colors duration-[var(--duration-hover)] ease-standard"
          >
            退出登录
          </button>
        </form>
      </div>
    </>
  );

  return (
    <div className="bg-canvas flex h-dvh w-full overflow-hidden">
      {/* 桌面常驻侧栏 */}
      <div className="border-border-default bg-surface-1 font-zh w-sidebar hidden h-full shrink-0 flex-col border-r md:flex">
        {sidebarBody}
      </div>

      {/* 移动端抽屉 */}
      {drawerOpen && (
        <div
          className="bg-canvas/60 fixed inset-0 z-100 md:hidden"
          onClick={() => setDrawerOpen(false)}
        >
          <div
            role="dialog"
            aria-modal
            aria-label="主导航"
            onClick={(e) => e.stopPropagation()}
            className="border-border-default bg-surface-1 font-zh shadow-flyout flex h-full w-sidebar max-w-[85vw] flex-col border-r"
          >
            {sidebarBody}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-canvas border-border-default font-zh flex h-14 shrink-0 items-center gap-3 border-b px-4 md:px-6">
          <IconButton
            aria-label="打开导航"
            onClick={() => setDrawerOpen(true)}
            size={32}
            className="md:hidden"
          >
            <Icon name="more" size={18} />
          </IconButton>
          <h1 className="text-fg text-body min-w-0 flex-1 truncate font-medium">
            {title}
          </h1>
          <ThemeToggle />
        </header>

        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
