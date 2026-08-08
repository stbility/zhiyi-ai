import type { Metadata } from "next";

import { PricingCard } from "@/components/account/PricingCard";
import { Badge } from "@/components/primitives/Badge";
import { LinkButton } from "@/components/primitives/LinkButton";
import { Tag } from "@/components/primitives/Tag";
import { PLANS } from "@/lib/plans";

export const metadata: Metadata = {
  title: "订阅方案 · 智一 AI",
  description: "面向全球华人的 AI 工作流订阅方案,香港主体运营,港币定价。",
};

/**
 * 订阅方案页。
 *
 * 全部使用智一 AI 原生设计系统组件与 token:
 *   · PricingCard —— 定价卡片(CTA 为外部 Stripe Payment Link)
 *   · Badge / Tag —— 徽标与标签
 *   · LinkButton external —— 外部支付链接(新开标签页 + noopener)
 * 不拼接、不手抄类名、不写死颜色 —— 与设计系统守卫测试一致。
 *
 * 价格与支付链接的唯一来源是 @/lib/plans(plans.ts)——
 * 不在页面里重复定义,改价格/链接只改一处。
 */

const MARKET_TIERS = [
  {
    region: "港澳台",
    flag: "🇭🇰",
    currency: "HKD",
    methods: ["支付宝香港版", "WeChat Pay HK", "FPS 转数快", "信用卡"],
    note: "港币定价,本地支付无缝衔接",
  },
  {
    region: "东南亚华人",
    flag: "🌏",
    currency: "SGD / MYR / THB",
    methods: ["GrabPay", "Boost", "Touch 'n Go", "国际信用卡"],
    note: "本地钱包 + 国际卡双支持",
  },
  {
    region: "欧美华人",
    flag: "🌍",
    currency: "USD",
    methods: ["Visa / Mastercard / Amex", "PayPal", "英语界面"],
    note: "国际标准通道,零摩擦接入",
  },
];

export default function PricingPage() {
  return (
    <main className="bg-canvas font-zh min-h-screen">
      {/* Nav */}
      <nav className="border-border-default sticky top-0 z-50 border-b bg-canvas/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <LinkButton href="/" className="text-lg font-bold no-underline">
            智一 <span className="text-brand">AI</span>
          </LinkButton>
          <LinkButton href="/" variant="secondary" size="sm">
            返回首页
          </LinkButton>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden px-6 py-24 text-center">
        <div className="mx-auto max-w-2xl">
          <Badge tone="brand" className="mb-6">
            🌏 面向全球华人
          </Badge>
          <h1 className="text-fg font-zh text-4xl font-semibold leading-tight tracking-tight">
            你的<span className="text-brand">智能工作流</span>
            <br />
            说中文就能跑
          </h1>
          <p className="text-fg-secondary mt-6 text-lg">
            智一 AI 为全球华人知识工作者而建。
            <br />
            香港主体运营,港币定价,三层支付网络全覆盖。
          </p>
        </div>
      </section>

      {/* Market Tiers */}
      <section className="mx-auto max-w-5xl px-6 py-16">
        <h2 className="text-fg-tertiary mb-2 text-xs font-bold uppercase tracking-widest">
          分层运营
        </h2>
        <p className="text-fg mb-8 text-2xl font-semibold">
          为全球华人量身打造的支付与服务
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {MARKET_TIERS.map((tier) => (
            <div
              key={tier.region}
              className="bg-surface-2 border-border-default rounded-card flex flex-col gap-3 border p-6"
            >
              <p className="text-fg-tertiary text-xs font-bold uppercase tracking-widest">
                {tier.flag} {tier.region}
              </p>
              <h3 className="text-fg text-base font-semibold">{tier.note}</h3>
              <p className="text-fg-tertiary text-xs">{tier.currency}</p>
              <div className="flex flex-wrap gap-1.5">
                {tier.methods.map((m) => (
                  <Tag key={m}>{m}</Tag>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="bg-surface-2 border-border-default mt-4 flex items-center gap-3 rounded-card border p-4">
          <Badge tone="warning">大陆用户</Badge>
          <p className="text-fg-secondary text-sm">
            可通过支付宝与微信支付(部分功能)直接订阅
          </p>
        </div>
      </section>

      {/* Plans */}
      <section className="mx-auto max-w-4xl px-6 py-16">
        <h2 className="text-fg-tertiary mb-2 text-center text-xs font-bold uppercase tracking-widest">
          订阅方案
        </h2>
        <p className="text-fg mb-12 text-center text-2xl font-semibold">
          选择适合你的工作流方案
        </p>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          {PLANS.map((plan) => (
            <div key={plan.id} className="flex justify-center">
              <PricingCard
                name={plan.name}
                price={plan.price ?? "价格待定"}
                period={plan.period ?? ""}
                features={plan.features}
                highlighted={plan.highlighted}
                annualNote={plan.annualNote}
                annualHref={plan.annualStripeUrl}
                ctaLabel={`立即订阅 ${plan.price ?? ""}`}
                href={plan.stripeUrl}
                external
                className="w-full"
              />
            </div>
          ))}
        </div>
      </section>

      {/* Footer CTA */}
      <section className="relative overflow-hidden px-6 py-24 text-center">
        <div className="mx-auto">
          <h2 className="text-fg mb-4 text-3xl font-semibold">
            开始你的智能工作流
          </h2>
          <p className="text-fg-secondary mb-8 text-lg">
            从专业版开始,随团队成长无缝升级至企业版。
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <LinkButton
              href={PLANS.find((p) => p.id === "professional")?.stripeUrl ?? "/"}
              external
              size="lg"
            >
              订阅专业版 {PLANS.find((p) => p.id === "professional")?.price ?? ""} →
            </LinkButton>
            <LinkButton
              href={PLANS.find((p) => p.id === "enterprise")?.stripeUrl ?? "/"}
              external
              variant="secondary"
              size="lg"
            >
              企业版 {PLANS.find((p) => p.id === "enterprise")?.price ?? ""}
            </LinkButton>
          </div>
        </div>
      </section>

      <footer className="border-border-default border-t py-8 text-center">
        <p className="text-fg-tertiary text-sm">
          <LinkButton href="/" className="no-underline">
            智一 AI
          </LinkButton>{" "}
          · 香港主体运营 · 支援全球华人社区
        </p>
        <p className="text-fg-tertiary mt-1 text-xs">© 2026 智一 AI™</p>
      </footer>
    </main>
  );
}
