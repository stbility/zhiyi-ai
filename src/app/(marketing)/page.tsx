import type { Metadata } from "next";

import { PricingCard } from "@/components/account/PricingCard";
import { ProductShowcase } from "@/components/marketing/ProductShowcase";
import { ScrollReveal } from "@/components/marketing/ScrollReveal";
import { Icon, type IconName } from "@/components/icons/Icon";
import { MemoryCard } from "@/components/memory/MemoryCard";
import { Badge } from "@/components/primitives/Badge";
import { buttonClasses } from "@/components/primitives/Button";
import { LinkButton } from "@/components/primitives/LinkButton";
import { PLANS } from "@/lib/plans";

export const metadata: Metadata = {
  title: "智一 AI · 个人 AI 工作流操作系统",
  description:
    "智一 AI 把工作流、知识与记忆整合进同一个系统,让 AI 的每一次建议都能转化为明确的行动。",
};

const POSITIONING = [
  {
    title: "工作流优先",
    body: "不是聊天机器人,而是围绕任务执行构建的操作系统。",
  },
  {
    title: "上下文优先",
    body: "AI 建议基于您的知识库与记忆,而非单纯的模型能力展示。",
  },
  {
    title: "行动优先",
    body: "每一次 AI 输出都能直接转化为任务、文档或工作流节点。",
  },
] as const;

const LOOP_STEPS = [
  "输入资料",
  "AI Agent 分工执行",
  "生成结果与引用",
  "用户确认",
  "沉淀为记忆与知识",
] as const;

const SECURITY: readonly { icon: IconName; label: string }[] = [
  { icon: "shield", label: "密钥加密存储,不进入日志与前端产物" },
  { icon: "eye", label: "记忆全程可见、可编辑、可删除" },
  { icon: "check", label: "行级安全策略隔离用户与组织数据" },
];

function Section({
  id,
  children,
  className,
}: {
  id?: string | undefined;
  children: React.ReactNode;
  className?: string | undefined;
}) {
  return (
    <section id={id} className="mx-auto max-w-280 px-6 py-24">
      <ScrollReveal className={className}>{children}</ScrollReveal>
    </section>
  );
}

export default function HomePage() {
  return (
    <main>
      {/* 首屏 */}
      <div className="relative overflow-hidden">
        {/* 品牌辉光 —— 设计规范允许的唯一例外,由 --brand-primary 派生,见 globals.css */}
        <div
          aria-hidden
          className="bg-hero-glow pointer-events-none absolute -top-50 left-1/2 h-125 w-225 -translate-x-1/2"
        />
        <Section className="relative flex flex-col items-center gap-6 text-center">
          <Badge tone="brand">个人 AI 工作流操作系统</Badge>

          <h1 className="font-zh text-fg max-w-195 text-[40px] leading-[1.25] font-semibold md:text-[56px]">
            平静、智能、可信赖的
            <br />
            AI 工作操作系统
          </h1>

          <p className="font-zh text-fg-secondary max-w-140 text-[17px] leading-[1.75]">
            智一 AI 把工作流、知识与记忆整合进同一个系统,让 AI
            的每一次建议都能转化为明确的行动。
          </p>

          <div className="flex flex-wrap justify-center gap-3">
            <LinkButton href="/register" size="lg">
              免费开始使用
            </LinkButton>
            {/* 同页锚点,不是路由跳转 —— 保持原生 <a>。
                LinkButton 里的 next/link 对 #锚点没有意义,
                external 又会新开标签页,两个都不对。 */}
            <a
              href="#product"
              className={buttonClasses({ variant: "secondary", size: "lg" })}
            >
              查看产品界面
            </a>
          </div>

          <div id="product" className="mt-8 w-full scroll-mt-20">
            <ProductShowcase />
          </div>
        </Section>
      </div>

      {/* 定位 */}
      <Section className="grid grid-cols-1 gap-8 md:grid-cols-3">
        {POSITIONING.map((item) => (
          <div key={item.title} className="flex flex-col gap-2.5">
            <h2 className="font-zh text-fg text-[20px] font-semibold">
              {item.title}
            </h2>
            <p className="font-zh text-fg-secondary text-body leading-[1.75]">
              {item.body}
            </p>
          </div>
        ))}
      </Section>

      {/* 工作流闭环 */}
      <Section id="workflow" className="scroll-mt-20">
        <h2 className="font-zh text-h2 text-fg mb-8 font-semibold">
          一个闭环:从任务到记忆
        </h2>
        <ol className="flex flex-wrap items-center gap-y-3">
          {LOOP_STEPS.map((step, index) => (
            <li key={step} className="flex items-center">
              <span className="bg-surface-2 border-border-default rounded-card font-zh text-fg border px-4.5 py-3.5 text-[14px]">
                {step}
              </span>
              {index < LOOP_STEPS.length - 1 && (
                <span aria-hidden className="text-fg-tertiary px-3">
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      </Section>

      {/* 记忆 */}
      <Section className="flex flex-col items-center gap-12 md:flex-row">
        <div className="flex-1">
          <h2 className="font-zh text-h2 text-fg mb-3 font-semibold">
            透明、可控的 AI 记忆
          </h2>
          <p className="font-zh text-fg-secondary text-body leading-[1.75]">
            每条记忆都标明来源:AI 自动推断、用户明确保存、从文件提取,或从工作流生成
            —— AI 不会把推断伪装成事实。
          </p>
        </div>
        <div className="w-full flex-1">
          <MemoryCard
            category="写作风格"
            content="偏好简洁、少用感叹号的商务中文写作风格。"
            source="inferred"
            createdAt="2026-06-02"
            lastUsedAt="2 小时前"
            confidence={82}
            scope="全部工作流"
          />
        </div>
      </Section>

      {/* 定价 */}
      <Section id="pricing" className="scroll-mt-20">
        <h2 className="font-zh text-h2 text-fg mb-8 text-center font-semibold">
          定价
        </h2>
        <div className="flex flex-wrap justify-center gap-5">
          {PLANS.map((plan) => (
            <PricingCard
              key={plan.id}
              name={plan.name}
              price={plan.price ?? "价格待定"}
              period={plan.period ?? ""}
              features={plan.features}
              highlighted={plan.highlighted}
              annualNote={plan.annualNote}
              ctaLabel={
                plan.id === "free"
                  ? "免费开始"
                  : `立即订阅 ${plan.price ?? ""}`
              }
              href={
                plan.id === "professional"
                  ? "https://buy.stripe.com/28E4gB8S35O54ga2JCfbq02"
                  : plan.id === "enterprise"
                    ? "https://buy.stripe.com/fZueVffgr2BT5ke1Fyfbq03"
                    : "/register"
              }
              external={plan.id !== "free"}
            />
          ))}
        </div>
      </Section>

      {/* 安全 */}
      <Section id="security" className="scroll-mt-20">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
          {SECURITY.map((item) => (
            <div
              key={item.label}
              className="font-zh text-fg-secondary flex items-start gap-2.5 text-[14px]"
            >
              <Icon
                name={item.icon}
                size={18}
                className="text-brand mt-0.5 shrink-0"
              />
              {item.label}
            </div>
          ))}
        </div>
      </Section>

      {/* 结尾 CTA */}
      <Section className="flex flex-col items-center gap-4.5 text-center">
        <h2 className="font-zh text-h2 text-fg font-semibold">
          开始构建您的 AI 工作流
        </h2>
        <LinkButton href="/register" size="lg">
          免费开始使用
        </LinkButton>
      </Section>
    </main>
  );
}
