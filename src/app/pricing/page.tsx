import { Metadata } from "next";
import { buttonClasses } from "@/components/primitives/Button";

export const metadata: Metadata = {
  title: "订阅方案 · 智一 AI",
  description: "面向全球华人的 AI 工作流订阅方案，香港主体运营，港币定价。",
};

const PLANS = [
  {
    id: "professional",
    name: "Professional",
    nameZh: "专业版",
    price: "HK$49",
    period: "月",
    annualPrice: "HK$490/年",
    desc: "适合个人知识工作者与独立研究者",
    features: [
      "多个工作流与自定义 Agent",
      "文件解析与向量检索",
      "工作流执行历史（30 天）",
      "每月 500 次 Agent 额度",
      "基础记忆沉淀",
    ],
    highlighted: true,
    checkoutUrl: "https://buy.stripe.com/28E4gB8S35O54ga2JCfbq02",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    nameZh: "企业版",
    price: "HK$229",
    period: "月",
    annualPrice: "HK$2,290/年",
    desc: "将个人工作流扩展到组织协作，面向专业团队",
    features: [
      "无限工作流与 Agent",
      "组织知识库与团队级检索",
      "成员管理与角色权限",
      "每月 5,000 次 Agent 额度",
      "完整审计日志（90 天）",
      "私有模型网关接入",
      "数据隔离与合规支持",
      "优先邮件 + 电话支持",
    ],
    highlighted: false,
    checkoutUrl: "https://buy.stripe.com/fZueVffgr2BT5ke1Fyfbq03",
  },
];

const MARKET_TIERS = [
  {
    region: "港澳台",
    flag: "🇭🇰",
    currency: "HKD",
    methods: ["支付宝香港版", "WeChat Pay HK", "FPS 轉數快", "信用卡"],
    note: "港币定价，本地支付无缝衔接",
  },
  {
    region: "東南亞華人",
    flag: "🌏",
    currency: "SGD / MYR / THB",
    methods: ["GrabPay", "Boost", "Touch 'n Go", "國際信用卡"],
    note: "本地钱包 + 国际卡双支持",
  },
  {
    region: "歐美華人",
    flag: "🌍",
    currency: "USD",
    methods: ["Visa / Mastercard / Amex", "PayPal", "英語介面"],
    note: "国际标准通道，零摩擦接入",
  },
];

export default function PricingPage() {
  return (
    <main className="min-h-screen bg-[#07080B] text-[#F4F6F8] font-sans">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-[#242832] bg-[rgba(7,8,11,0.85)] backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <a href="/" className="text-lg font-bold text-[#F4F6F8] no-underline">
            智一 <span className="text-[#6977E8]">AI</span>
          </a>
          <a
            href="/"
            className="text-sm font-medium text-[#C6CBD4] no-underline transition-colors hover:text-[#F4F6F8]"
          >
            返回首页
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden px-6 py-24 text-center">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 50% -20%, rgba(105,119,232,0.12) 0%, transparent 60%)",
          }}
        />
        <div className="relative mx-auto max-w-2xl">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[rgba(105,119,232,0.2)] bg-[rgba(105,119,232,0.12)] px-4 py-1.5 text-xs font-semibold text-[#6977E8]">
            🌏 面向全球華人
          </div>
          <h1 className="mb-4 text-4xl font-semibold leading-tight tracking-tight text-[#F4F6F8]">
            你的<span className="text-[#6977E8]">智能工作流</span>
            <br />
            說中文就能跑
          </h1>
          <p className="text-lg text-[#C6CBD4]">
            智一 AI 為全球華人知識工作者而建。
            <br />
            香港主體運營，港幣定價，三層支付網絡全覆蓋。
          </p>
        </div>
      </section>

      {/* Market Tiers */}
      <section className="mx-auto max-w-5xl px-6 py-16">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-[#6977E8]">
          分層運營
        </h2>
        <p className="mb-8 text-2xl font-semibold text-[#F4F6F8]">
          為全球華人量身打造的支付與服務
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {MARKET_TIERS.map((tier) => (
            <div
              key={tier.region}
              className="rounded-xl border border-[#242832] bg-[#12151C] p-6"
            >
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-[#8B929E]">
                {tier.flag} {tier.region}
              </p>
              <h3 className="mb-2 text-base font-semibold text-[#F4F6F8]">
                {tier.note}
              </h3>
              <p className="mb-4 text-xs text-[#C6CBD4]">
                {tier.methods.join(" · ")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {tier.methods.map((m) => (
                  <span
                    key={m}
                    className="rounded bg-[rgba(105,119,232,0.12)] px-2 py-0.5 text-xs font-semibold text-[#6977E8]"
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-[#242832] bg-[#0D0F14] p-4">
          <span className="rounded bg-[rgba(211,56,13,0.12)] px-2.5 py-1 text-xs font-bold text-[#E8734A]">
            大陸用戶
          </span>
          <p className="text-sm text-[#C6CBD4]">
            可通过支付宝与微信支付（部分功能）直接订阅
          </p>
        </div>
      </section>

      {/* Plans */}
      <section className="mx-auto max-w-4xl px-6 py-16">
        <h2 className="mb-2 text-center text-xs font-bold uppercase tracking-widest text-[#6977E8]">
          訂閱方案
        </h2>
        <p className="mb-12 text-center text-2xl font-semibold text-[#F4F6F8]">
          選擇適合你的工作流方案
        </p>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          {PLANS.map((plan) => (
            <div
              key={plan.id}
              className={`relative flex flex-col rounded-xl border p-8 ${
                plan.highlighted
                  ? "border-[#6977E8] bg-[#12151C] shadow-[0_0_0_3px_rgba(105,119,232,0.12),0_8px_32px_rgba(0,0,0,0.4)]"
                  : "border-[#242832] bg-[#0D0F14]"
              }`}
            >
              {plan.highlighted && (
                <div className="absolute -top-px right-6 rounded-b-lg bg-[#6977E8] px-4 py-1 text-xs font-bold text-white">
                  最受歡迎
                </div>
              )}
              <p className="mb-1 text-xs font-bold uppercase tracking-widest text-[#8B929E]">
                {plan.name}
              </p>
              <h3 className="mb-1 text-xl font-semibold text-[#F4F6F8]">
                {plan.nameZh}
              </h3>
              <div className="mb-1 flex items-baseline gap-1">
                <span className="text-lg font-semibold text-[#C6CBD4]">HK$</span>
                <span className="text-5xl font-semibold tracking-tight text-[#F4F6F8]">
                  {plan.price.replace("HK$", "")}
                </span>
                <span className="text-sm text-[#8B929E]">/{plan.period}</span>
              </div>
              <p className="mb-6 text-xs text-[#8B929E]">
                {plan.annualPrice} · 年付约省 2 个月
              </p>
              <p className="mb-6 min-h-[40px] text-sm text-[#C6CBD4]">{plan.desc}</p>
              <div className="mb-6 flex flex-col gap-3">
                {plan.features.map((f) => (
                  <div key={f} className="flex items-start gap-2.5 text-sm text-[#F4F6F8]">
                    <span className="mt-0.5 text-[#6977E8] font-bold text-xs">✓</span>
                    {f}
                  </div>
                ))}
              </div>
              <a
                href={plan.checkoutUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClasses({
                  variant: plan.highlighted ? "primary" : "secondary",
                  className: "mt-auto w-full justify-center",
                })}
              >
                立即订阅 {plan.price}
              </a>
            </div>
          ))}
        </div>
      </section>

      {/* Comparison Table */}
      <section className="mx-auto max-w-4xl px-6 py-16">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-[#6977E8]">
          功能對比
        </h2>
        <p className="mb-8 text-2xl font-semibold text-[#F4F6F8]">方案詳細對比</p>
        <div className="overflow-x-auto rounded-xl border border-[#242832]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#323846]">
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-[#8B929E]">
                  功能
                </th>
                <th className="px-4 py-3 text-center text-xs font-bold uppercase tracking-wider text-[#8B929E]">
                  專業版
                </th>
                <th className="px-4 py-3 text-center text-xs font-bold uppercase tracking-wider text-[#8B929E]">
                  企業版
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#242832]">
              {[
                ["自定義工作流", "10 個", "無限"],
                ["檔案解析與向量檢索", "✓", "✓"],
                ["執行歷史保留", "30 天", "90 天"],
                ["私有模型網關接入", "—", "✓"],
                ["成員與角色權限", "—", "✓"],
                ["組織知識庫", "—", "✓"],
                ["團隊級檢索", "—", "✓"],
                ["每月 Agent 調用", "500 次", "5,000 次"],
                ["超額用量計費", "—", "✓"],
                ["審計日誌", "—", "90 天"],
                ["數據隔離", "—", "✓"],
                ["SLA 保障", "—", "✓"],
                ["支援方式", "電子郵件", "優先郵件 + 電話"],
              ].map(([feature, pro, ent]) => (
                <tr key={feature} className="border-b border-[#242832] last:border-0">
                  <td className="px-4 py-3 text-[#F4F6F8]">{feature}</td>
                  <td className="px-4 py-3 text-center font-medium">{pro}</td>
                  <td className="px-4 py-3 text-center font-medium">{ent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Footer CTA */}
      <section className="relative overflow-hidden px-6 py-24 text-center">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 50% -20%, rgba(105,119,232,0.10) 0%, transparent 60%)",
          }}
        />
        <div className="relative">
          <h2 className="mb-4 text-3xl font-semibold text-[#F4F6F8]">
            開始你的智能工作流
          </h2>
          <p className="mb-8 text-lg text-[#C6CBD4]">
            從專業版開始，隨團隊成長無縫升級至企業版。
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <a
              href="https://buy.stripe.com/28E4gB8S35O54ga2JCfbq02"
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses({ variant: "primary", size: "lg" })}
            >
              訂閱專業版 HK$49 →
            </a>
            <a
              href="https://buy.stripe.com/fZueVffgr2BT5ke1Fyfbq03"
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses({ variant: "secondary", size: "lg" })}
            >
              企業版 HK$229
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-[#242832] py-8 text-center">
        <p className="text-sm text-[#8B929E]">
          <a href="/" className="text-[#8B929E] no-underline hover:text-[#6977E8]">
            智一 AI
          </a>{" "}
          · 香港主體運營 · 支援全球華人社區
        </p>
        <p className="mt-1 text-xs text-[#5F6671]">
          © 2026 智一 AI™ · 繁 / 簡 / English
        </p>
      </footer>
    </main>
  );
}
