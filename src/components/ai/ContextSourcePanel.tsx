import { Icon } from "@/components/icons/Icon";
import { cn } from "@/lib/cn";

export interface ContextSourcePanelProps {
  workflow?: string | undefined;
  knowledgeRefs?: readonly string[] | undefined;
  memoryRefs?: readonly string[] | undefined;
  className?: string | undefined;
}

/**
 * 当前上下文面板 —— 如实展示本次回答实际调用了哪些知识与记忆。
 * 列表为空即表示未调用,不得为了显得「有上下文」而填充内容。
 */
export function ContextSourcePanel({
  workflow,
  knowledgeRefs = [],
  memoryRefs = [],
  className,
}: ContextSourcePanelProps) {
  return (
    <div
      className={cn(
        "bg-surface-2 border-border-default rounded-card font-zh flex flex-col gap-3 border p-4",
        className,
      )}
    >
      <p className="text-fg-tertiary text-label font-medium">当前上下文</p>

      {workflow && (
        <p className="text-fg flex items-center gap-2 text-[13px]">
          <Icon name="workflow" size={14} className="text-brand shrink-0" />
          {workflow}
        </p>
      )}

      {knowledgeRefs.length > 0 && (
        <div>
          <p className="text-fg-tertiary mb-1.5 text-[11px]">已调用知识</p>
          <ul className="flex flex-col gap-1.5">
            {knowledgeRefs.map((ref) => (
              <li
                key={ref}
                className="text-fg-secondary flex items-center gap-1.5 text-[13px]"
              >
                <Icon
                  name="knowledge"
                  size={13}
                  className="text-fg-tertiary shrink-0"
                />
                {ref}
              </li>
            ))}
          </ul>
        </div>
      )}

      {memoryRefs.length > 0 && (
        <div>
          <p className="text-fg-tertiary mb-1.5 text-[11px]">已调用记忆</p>
          <ul className="flex flex-col gap-1.5">
            {memoryRefs.map((ref) => (
              <li
                key={ref}
                className="text-fg-secondary flex items-center gap-1.5 text-[13px]"
              >
                <Icon
                  name="memory"
                  size={13}
                  className="text-fg-tertiary shrink-0"
                />
                {ref}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
