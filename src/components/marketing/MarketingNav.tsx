import Link from "next/link";

import { LinkButton } from "@/components/primitives/LinkButton";

const LINKS = [
  { href: "#product", label: "产品" },
  { href: "#workflow", label: "工作流" },
  { href: "#pricing", label: "定价" },
  { href: "#security", label: "安全" },
] as const;

export function MarketingNav() {
  return (
    <header className="border-border-default bg-canvas/85 sticky top-0 z-10 border-b backdrop-blur-[8px]">
      <nav className="font-zh mx-auto flex max-w-280 items-center justify-between gap-6 px-6 py-4">
        <Link
          href="/"
          className="text-fg -my-2 flex min-h-11 items-center gap-2 py-2 text-[15px] font-semibold"
        >
          <span
            aria-hidden
            className="bg-brand text-on-brand flex size-6 items-center justify-center rounded-[6px] text-[12px]"
          >
            智
          </span>
          智一 AI
        </Link>

        <div className="text-fg-secondary hidden gap-7 text-[14px] md:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="hover:text-fg transition-colors duration-[var(--duration-hover)] ease-standard"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="flex gap-2.5">
          {/* 窄屏用 md(40px)保证触摸目标够大,桌面回到设计系统的 sm */}
          <LinkButton
            href="/login"
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-8"
          >
            登录
          </LinkButton>
          <LinkButton
            href="/register"
            size="sm"
            className="min-h-11 md:min-h-8"
          >
            免费开始
          </LinkButton>
        </div>
      </nav>
    </header>
  );
}
