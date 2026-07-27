import { Icon, type IconName } from "@/components/icons/Icon";
import { cn } from "@/lib/cn";

export const AI_RESPONSE_ACTIONS = [
  { key: "citation", label: "查看引用", icon: "link" },
  { key: "saveKnowledge", label: "保存为知识", icon: "knowledge" },
  { key: "saveMemory", label: "保存为记忆", icon: "memory" },
  { key: "addWorkflow", label: "加入工作流", icon: "workflow" },
  { key: "createTask", label: "创建任务", icon: "check" },
  { key: "edit", label: "继续编辑", icon: "edit" },
  { key: "export", label: "导出文档", icon: "upload" },
] as const satisfies ReadonlyArray<{
  key: string;
  label: string;
  icon: IconName;
}>;

export type AIResponseActionKey = (typeof AI_RESPONSE_ACTIONS)[number]["key"];

export interface AIResponseActionsProps {
  onAction?: ((key: AIResponseActionKey) => void) | undefined;
  /** 未接通的能力应列在这里显示为不可用,而不是渲染成点了没反应的按钮 */
  disabledActions?: readonly AIResponseActionKey[] | undefined;
  className?: string | undefined;
}

export function AIResponseActions({
  onAction,
  disabledActions = [],
  className,
}: AIResponseActionsProps) {
  return (
    <div className={cn("font-zh flex flex-wrap gap-1.5", className)}>
      {AI_RESPONSE_ACTIONS.map((action) => {
        const disabled = disabledActions.includes(action.key);
        return (
          <button
            key={action.key}
            type="button"
            disabled={disabled}
            onClick={() => onAction?.(action.key)}
            className={cn(
              "bg-surface-2 border-border-default rounded-control text-fg-secondary text-label flex items-center gap-1.5 border px-2.5 py-1.5",
              "transition-colors duration-[var(--duration-hover)] ease-standard",
              disabled
                ? "cursor-not-allowed opacity-45"
                : "hover:bg-surface-3 cursor-pointer",
            )}
          >
            <Icon name={action.icon} size={13} />
            {action.label}
          </button>
        );
      })}
    </div>
  );
}
