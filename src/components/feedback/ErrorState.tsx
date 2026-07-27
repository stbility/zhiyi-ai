import { Icon } from "@/components/icons/Icon";
import { Button } from "@/components/primitives/Button";

export interface ErrorStateProps {
  title?: string | undefined;
  description?: string | undefined;
  onRetry?: (() => void) | undefined;
}

export function ErrorState({
  title = "出现问题",
  description,
  onRetry,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="font-zh flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-center"
    >
      <span className="bg-error-tint rounded-card flex size-11 items-center justify-center">
        <Icon name="alert" size={20} className="text-error" />
      </span>
      <p className="text-fg text-body font-medium">{title}</p>
      {description && (
        <p className="text-fg-tertiary text-caption max-w-80">{description}</p>
      )}
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-1.5">
          重试
        </Button>
      )}
    </div>
  );
}
