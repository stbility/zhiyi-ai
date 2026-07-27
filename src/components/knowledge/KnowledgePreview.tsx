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
 * 不是独立的浅色应用。正文宽度受 --reading-measure 约束,不做通栏。
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
      <article className="bg-paper-surface border-paper-border text-paper-fg font-zh rounded-control max-w-reading mx-auto border px-8 py-7">
        <h2 className="mb-1.5 text-[20px] font-semibold">{title}</h2>
        {updatedAt && (
          <p className="text-paper-fg-secondary text-label mb-4">
            最近更新 · {updatedAt}
          </p>
        )}
        <div className="text-body-lg leading-[1.75]">{children}</div>
      </article>
    </div>
  );
}
