import { Icon, type IconName } from "@/components/icons/Icon";
import { Button } from "@/components/primitives/Button";

export interface EmptyStateProps {
  icon?: IconName | undefined;
  title: string;
  description?: string | undefined;
  actionLabel?: string | undefined;
  onAction?: (() => void) | undefined;
}

export function EmptyState({
  icon = "knowledge",
  title,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  return (
    <div className="font-zh flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-center">
      <span className="bg-surface-3 rounded-card flex size-11 items-center justify-center">
        <Icon name={icon} size={20} className="text-fg-tertiary" />
      </span>
      <p className="text-fg text-body font-medium">{title}</p>
      {description && (
        <p className="text-fg-tertiary text-caption max-w-80">{description}</p>
      )}
      {actionLabel && (
        <Button size="sm" onClick={onAction} className="mt-1.5 px-4 py-2">
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
