import type { Metadata } from "next";

import { ContactForm } from "@/components/app/ContactForm";

export const metadata: Metadata = { title: "联系销售 · 智一 AI" };

export default function ContactPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-8 md:py-10">
      <header>
        <h2 className="text-fg text-h2 font-zh font-semibold">
          联系销售 · Enterprise 版
        </h2>
        <p className="text-fg-secondary font-zh text-caption mt-2">
          SSO/SAML、私有模型网关或专属部署、自定义额度与并发、数据保留与审计导出、正式 SLA。
          留下联系方式,销售团队将在 1 个工作日内联系你。
        </p>
      </header>

      <ContactForm />
    </div>
  );
}
