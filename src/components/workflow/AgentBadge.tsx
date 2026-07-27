import { cn } from "@/lib/cn";

export interface AgentBadgeProps {
  name: string;
  role?: string | undefined;
  className?: string | undefined;
}

export function AgentBadge({ name, role, className }: AgentBadgeProps) {
  return (
    <span
      className={cn(
        "font-zh bg-surface-3 border-border-default inline-flex items-center gap-1.5 rounded-full border py-[3px] pr-[9px] pl-[5px]",
        className,
      )}
    >
      <span
        aria-hidden
        className="bg-brand-tint text-brand flex size-4 items-center justify-center rounded-full text-[9px] font-bold"
      >
        {name.slice(0, 1)}
      </span>
      <span className="text-fg-secondary text-label">
        {name}
        {role ? ` · ${role}` : ""}
      </span>
    </span>
  );
}
