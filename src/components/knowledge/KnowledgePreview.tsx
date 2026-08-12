import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface KnowledgePreviewProps {
  title: string;
  updatedAt?: string | undefined;
  children?: ReactNode | undefined;
  className?: string | undefined;
}

/**
 * 文档阅读面。
 *
 * 这是设计系统中唯一使用浅色「纸张」画布的场景 —— 且必须嵌套在深色应用框架内,
 * 不是独立的浅色应用。
 *
 * 2026-08-12 修复(用户反馈):
 * 1. 正文宽度放宽 —— 此前 max-w-reading(760px) 太窄,解析页像「竖条」;
 *    本地文件夹打开是全宽,预览应尽量接近,改为 max-w-[1200px] 不再「很窄」。
 * 2. 前景色必须用 paper token —— 此前 children 由调用方传入
 *    text-fg-secondary(深色主题前景),在白色纸张上对比度错乱,文字
 *    「叠加/看不清」。统一在 article 内用 text-paper-fg。
 */
export function KnowledgePreview({
  title,
  updatedAt,
  children,
  className,
}: KnowledgePreviewProps) {
  return (
    <div
      className={cn(
        "bg-surface-1 border-border-default rounded-panel h-full border p-4",
        className,
      )}
    >
      <article className="bg-paper-surface border-paper-border text-paper-fg font-zh max-w-[1200px] mx-auto rounded-control border px-6 py-6 sm:px-10 sm:py-8">
        <h2 className="text-paper-fg mb-1.5 text-[20px] font-semibold">
          {title}
        </h2>
        {updatedAt && (
          <p className="text-paper-fg-secondary text-label mb-4">
            最近更新 · {updatedAt}
          </p>
        )}
        <div className="text-[14px] leading-[1.75]">{children}</div>
      </article>
    </div>
  );
}
