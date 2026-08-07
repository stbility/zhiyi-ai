import "server-only";

import Link from "next/link";
import { redirect } from "next/navigation";

import { BillingPortalButton } from "@/components/account/BillingPortalButton";
import { UsageMeter } from "@/components/account/UsageMeter";
import { getMyEntitlements, quotaOf } from "@/lib/billing/entitlements";
import { isStripeConfigured } from "@/lib/billing/stripe";
import { PLANS } from "@/lib/plans";
import { getCurrentUser } from "@/lib/supabase/server";

export const metadata = { title: "账单与套餐 · 智一 AI" };

/**
 * 账单与套餐页。
 *
 * 当前套餐、用量、权益一览 + 升级/管理订阅入口。
 * 权益与用量都来自数据库(0034/0035),不信任任何客户端状态。
 *
 * 支付未接通时如实展示「暂不可购买」—— 不渲染假按钮。
 */
export default async function BillingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const stripeReady = isStripeConfigured();
  const entitlements = await getMyEntitlements();

  const planId = entitlements?.planId ?? "free";
  // PLANS[0] 恒为 free,兜底不会 miss —— 用 ! 断言类型而非运行时依赖
  const plan = PLANS.find((p) => p.id === planId) ?? PLANS[0]!;

  const turnsQuota = entitlements ? quotaOf(entitlements, "monthly_agent_turns") : null;
  const workflowsQuota = entitlements
    ? quotaOf(entitlements, "workflows")
    : null;

  return (
    <main className="font-zh mx-auto flex max-w-180 flex-col gap-8 px-6 py-10">
      <header>
        <h1 className="text-fg text-[22px] font-semibold">账单与套餐</h1>
        <p className="text-fg-tertiary text-[13px]">
          当前套餐:{plan.name} · 订阅状态由 Stripe 实时同步,不信任本地缓存。
        </p>
      </header>

      {/* 当前套餐卡 */}
      <section className="bg-surface-2 border-border-default rounded-panel flex flex-col gap-3 border p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-fg text-[16px] font-semibold">{plan.name}</h2>
          <span className="text-fg-tertiary text-caption">
            {plan.price ? `${plan.price}/${plan.period}` : "价格待定"}
          </span>
        </div>

        <ul className="flex flex-col gap-2">
          {plan.features.map((feature) => (
            <li
              key={feature}
              className="text-fg-secondary flex items-start gap-2 text-[13px]"
            >
              <span className="text-success mt-0.5">✓</span>
              {feature}
            </li>
          ))}
        </ul>

        <div className="mt-2 flex flex-wrap gap-3">
          {planId === "free" ? (
            <Link
              href="/settings/billing?upgrade=1"
              className="bg-brand text-on-brand rounded-card px-4 py-2 text-[13px] font-medium"
            >
              升级套餐
            </Link>
          ) : (
            <BillingPortalButton disabled={!stripeReady} />
          )}
        </div>

        {!stripeReady && (
          <p className="text-fg-tertiary text-label">
            支付通道尚未接通,暂不可购买或管理订阅。
          </p>
        )}
      </section>

      {/* 用量 */}
      <section className="bg-surface-2 border-border-default rounded-panel flex flex-col gap-4 border p-6">
        <h2 className="text-fg text-[16px] font-semibold">本月用量</h2>
        <UsageMeter
          label="智能体运行次数"
          used={0}
          total={turnsQuota ?? 0}
          unit=" 次"
        />
        <UsageMeter
          label="工作流数量"
          used={0}
          total={workflowsQuota ?? 0}
          unit=" 个"
        />
        <p className="text-fg-tertiary text-label">
          用量计量上线后自动填充 —— 当前显示为 0 不代表额度已耗尽。
        </p>
      </section>

      {/* 升级档位 */}
      {planId === "free" && (
        <section className="flex flex-col gap-4">
          <h2 className="text-fg text-[16px] font-semibold">升级解锁</h2>
          <div className="flex flex-wrap gap-4">
            {PLANS.filter((p) => p.id !== "free").map((p) => (
              <div
                key={p.id}
                className="bg-surface-2 border-border-default rounded-panel flex w-64 flex-col gap-2 border p-5"
              >
                <h3 className="text-fg text-[14px] font-semibold">{p.name}</h3>
                <p className="text-fg-tertiary text-caption">
                  {p.price
                    ? `${p.price}/${p.period}`
                    : "价格待定"}
                  {p.annualNote ? ` · ${p.annualNote}` : ""}
                </p>
                <ul className="flex flex-col gap-1.5">
                  {p.features.slice(0, 4).map((f) => (
                    <li
                      key={f}
                      className="text-fg-secondary text-[12px]"
                    >
                      · {f}
                    </li>
                  ))}
                </ul>
                {stripeReady ? (
                  <BillingPortalButton
                    label={`升级 ${p.name}`}
                    upgradePriceId={p.stripePriceId}
                  />
                ) : (
                  <span className="text-fg-tertiary text-label">
                    暂不可购买
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
