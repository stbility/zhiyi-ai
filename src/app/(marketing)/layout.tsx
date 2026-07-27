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
        <p className="mt-2">
          <Link
            href="/status"
            className="hover:text-fg-secondary transition-colors duration-[var(--duration-hover)] ease-standard"
          >
            系统状态
          </Link>
        </p>
      </footer>
    </>
  );
}
