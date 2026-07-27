import Link from "next/link";
import type { ReactNode } from "react";

export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string | undefined;
  children: ReactNode;
  footer?: ReactNode | undefined;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-100">
        <Link
          href="/"
          className="mb-8 flex items-center justify-center gap-2.5"
        >
          <span
            aria-hidden
            className="bg-brand text-on-brand rounded-control flex size-7 items-center justify-center text-[14px] font-semibold"
          >
            智
          </span>
          <span className="text-fg font-zh text-body font-semibold">
            智一 AI
          </span>
        </Link>

        <div className="bg-surface-2 border-border-default rounded-panel border p-6">
          <h1 className="text-fg font-zh text-h3 font-medium">{title}</h1>
          {description && (
            <p className="text-fg-secondary font-zh text-caption mt-2">
              {description}
            </p>
          )}
          <div className="mt-6">{children}</div>
        </div>

        {footer && (
          <p className="text-fg-tertiary font-zh text-caption mt-5 text-center">
            {footer}
          </p>
        )}
      </div>
    </main>
  );
}
