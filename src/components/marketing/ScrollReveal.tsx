"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { cn } from "@/lib/cn";

/**
 * 滚动进场。
 *
 * 严格遵守设计系统的动效约束(见设计系统 readme「Motion」):只用透明度与
 * 小位移,时长取页面进场的 220ms,标准 ease-out。不做缩放弹跳、不闪烁、
 * 不在正文后面放任何移动的东西。
 *
 * 尊重 prefers-reduced-motion:前庭功能障碍者会因位移产生眩晕,
 * 这不是可选的润色项。系统关掉动效时内容直接呈现。
 *
 * 实现要点:动效偏好用 useSyncExternalStore 读取,而不是在 effect 里 setState ——
 * 后者会触发级联渲染。服务端快照返回「减少动效」,因此 SSR 产出的是完全可见的
 * 内容:即便脚本未执行,页面也照常可读,不会因动效实现失败而白屏。
 */

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToMotionPreference(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getMotionPreference(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** 服务端一律按「减少动效」处理,保证无脚本时内容可见 */
function getServerMotionPreference(): boolean {
  return true;
}

export function ScrollReveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  /** 依次进场的错峰延迟,单位 ms */
  delay?: number | undefined;
  className?: string | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(false);

  const reduceMotion = useSyncExternalStore(
    subscribeToMotionPreference,
    getMotionPreference,
    getServerMotionPreference,
  );

  useEffect(() => {
    if (reduceMotion || typeof IntersectionObserver === "undefined") return;

    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            // setState 发生在订阅回调里,不是 effect 主体 —— 不会级联渲染
            setRevealed(true);
            observer.disconnect();
          }
        }
      },
      // 进入视口约 12% 即触发,早于完全可见,避免「滚到了才开始动」
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [reduceMotion]);

  const animate = !reduceMotion;
  const hidden = animate && !revealed;

  return (
    <div
      ref={ref}
      style={hidden && delay > 0 ? { transitionDelay: `${delay}ms` } : undefined}
      className={cn(
        animate &&
          "transition-[opacity,transform] duration-[var(--duration-enter)] ease-standard",
        hidden && "translate-y-3 opacity-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
