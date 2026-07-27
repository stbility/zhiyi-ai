import Link from "next/link";

import { buttonClasses } from "@/components/primitives/Button";

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
          className="text-fg flex items-center gap-2 text-[15px] font-semibold"
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
          <Link
            href="/login"
            className={buttonClasses({ variant: "ghost", size: "sm" })}
          >
            登录
          </Link>
          <Link href="/register" className={buttonClasses({ size: "sm" })}>
            免费开始
          </Link>
        </div>
      </nav>
    </header>
  );
}
