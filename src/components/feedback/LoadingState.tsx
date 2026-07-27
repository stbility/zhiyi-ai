export interface LoadingStateProps {
  label?: string | undefined;
}

export function LoadingState({ label = "正在加载…" }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="font-zh flex flex-col items-center justify-center gap-3 px-6 py-12"
    >
      <span
        aria-hidden
        className="border-surface-4 border-t-brand animate-ds-spin size-[22px] rounded-full border-2"
      />
      <span className="text-fg-tertiary text-caption">{label}</span>
    </div>
  );
}
