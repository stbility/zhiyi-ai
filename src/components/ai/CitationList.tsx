import { cn } from "@/lib/cn";

export interface Citation {
  id: string;
  title: string;
  snippet?: string | undefined;
}

export interface CitationListProps {
  citations?: readonly Citation[] | undefined;
  className?: string | undefined;
}

/**
 * 引用列表。
 *
 * 产品规则:引用必须指向真实检索到的来源。此组件只负责渲染,
 * 调用方不得传入未经检索验证的条目来制造「有据可依」的假象。
 */
export function CitationList({ citations = [], className }: CitationListProps) {
  return (
    <ol className={cn("font-zh flex flex-col gap-2", className)}>
      {citations.map((citation, index) => (
        <li
          key={citation.id}
          className="bg-surface-2 border-border-default rounded-control flex items-start gap-2 border px-2.5 py-2"
        >
          <span className="text-brand shrink-0 font-mono text-[11px]">
            [{index + 1}]
          </span>
          <span>
            <span className="text-fg block text-[13px]">{citation.title}</span>
            {citation.snippet && (
              <span className="text-fg-tertiary text-label mt-0.5 block">
                {citation.snippet}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
