import Link from "next/link";

import { MarketingNav } from "@/components/marketing/MarketingNav";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <MarketingNav />
      {children}
      <footer className="border-border-default font-zh text-fg-tertiary border-t px-6 py-8 text-center text-[13px]">
        <p>© 2026 智一 AI™</p>
        <p className="mt-1">
          {/* 内边距撑到 44px 触摸目标,视觉上仍是一行小字 */}
          <Link
            href="/status"
            className="hover:text-fg-secondary inline-flex min-h-11 items-center px-3 transition-colors duration-[var(--duration-hover)] ease-standard"
          >
            系统状态
          </Link>
        </p>
      </footer>
    </>
  );
}
