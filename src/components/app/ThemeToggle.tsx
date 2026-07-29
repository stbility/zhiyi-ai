"use client";

import { useEffect, useSyncExternalStore } from "react";

import { Icon } from "@/components/icons/Icon";
import { cn } from "@/lib/cn";

/**
 * 深色 / 浅色切换。
 *
 * 设计系统本身只有深色,浅色是在 globals.css 里由 --paper-* 令牌派生出来的
 * 一层覆盖(见那里的注释)。这里只负责在 <html> 上挂 data-theme,并记住选择。
 *
 * 三档而不是两档:「跟随系统」是默认值 —— 很多人的系统本来就会按时间自动切换,
 * 强行只给两个开关等于把这个能力拿掉。
 */

export type ThemeChoice = "system" | "dark" | "light";

const STORAGE_KEY = "zhiyi-theme";
/** 同一页内切换主题时用的自定义事件 —— storage 事件不会在本页触发 */
const THEME_EVENT = "zhiyi-theme-change";

const OPTIONS: readonly {
  value: ThemeChoice;
  label: string;
  icon: "sun" | "moon" | "monitor";
}[] = [
  { value: "light", label: "浅色", icon: "sun" },
  { value: "dark", label: "深色", icon: "moon" },
  { value: "system", label: "跟随系统", icon: "monitor" },
];

/** 把选择落到 DOM 上。system 时移除属性,交回 prefers-color-scheme 决定 */
function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", dark ? "dark" : "light");
  } else {
    root.setAttribute("data-theme", choice);
  }
}

/** 订阅本地存储的变更(含其它标签页改主题的情况) */
function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(THEME_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(THEME_EVENT, onChange);
  };
}

function readStored(): ThemeChoice {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return saved === "dark" || saved === "light" ? saved : "system";
}

export function ThemeToggle() {
  // 用 useSyncExternalStore 而不是「useState + effect 里 setState」:
  // 后者会引起级联渲染(lint 也会拦),而且服务端首帧与客户端读到的值不同
  // 本来就容易造成水合不一致。这个 API 正是为「外部可变数据源」设计的:
  // 服务端快照固定为 system,客户端读本地存储,React 自己处理这一次差异。
  const choice = useSyncExternalStore<ThemeChoice>(
    subscribe,
    readStored,
    () => "system",
  );

  useEffect(() => {
    apply(choice);
    if (choice === "system") {
      // 跟随系统时要响应系统切换,否则用户改了系统设置这里纹丝不动
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => apply("system");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    return undefined;
  }, [choice]);

  function pick(next: ThemeChoice) {
    window.localStorage.setItem(STORAGE_KEY, next);
    // storage 事件只在其它标签页触发,本页要自己发一个
    window.dispatchEvent(new Event(THEME_EVENT));
  }

  return (
    <div
      role="group"
      aria-label="界面主题"
      className="border-border-default rounded-control flex items-center gap-0.5 border p-0.5"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => pick(o.value)}
          aria-pressed={choice === o.value}
          aria-label={o.label}
          title={o.label}
          className={cn(
            "rounded-control cursor-pointer p-1.5",
            "transition-colors duration-[var(--duration-hover)] ease-standard",
            choice === o.value
              ? "bg-brand-tint text-brand"
              : "text-fg-tertiary hover:text-fg-secondary",
          )}
        >
          <Icon name={o.icon} size={15} />
        </button>
      ))}
    </div>
  );
}
