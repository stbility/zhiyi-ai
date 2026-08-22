'use server'

import { PLANS, type PlanId } from '@/lib/plans'
import { paymentLinkEnvKey } from '@/lib/billing/stripe'

/**
 * ⚠️ 遗留 server action(2026-08-13 排查):CheckoutButton 组件全仓库无挂载,
 * startCheckout 无 userId 归属(创建的 Session 不带 metadata.userId,订阅
 * 无法落到账号),策略也与主路径相反(它优先 Payment Link,主路径
 * /api/billing/checkout 优先 Checkout Session)。保留仅为对照,不要再接入。
 */

export interface CheckoutResult {
  success: true
  url: string
}

export interface CheckoutError {
  success: false
  error: string
}

/**
 * 创建 Stripe Checkout Session。
 * 优先使用 Payment Link(最简,无需服务端 Session);
 * 未配置 Payment Link 时降级为服务端 Checkout Session。
 */
export async function startCheckout(
  planId: PlanId,
  interval: 'month' | 'year',
): Promise<CheckoutResult | CheckoutError> {
  const plan = PLANS.find((p) => p.id === planId)
  if (!plan) return { success: false, error: 'Unknown plan' }
  if (plan.id === 'free') return { success: false, error: 'Free plan has no checkout' }

  const paymentLink =
    interval === 'month' ? plan.paymentLinkMonth : plan.paymentLinkYear
  const priceId =
    interval === 'month' ? plan.priceIdMonth : plan.priceIdYear

  // 优先 Payment Link(Stripe 托管页,无需服务端 Session)
  if (paymentLink) {
    return { success: true, url: paymentLink }
  }

  // 降级:服务端创建 Checkout Session
  if (!priceId) {
    // 变量名走 paymentLinkEnvKey(PLAN_ENV_CODE)生成 —— 手写 toUpperCase
    // 会拼出 STRIPE_PAYMENT_LINK_PROFESSIONAL_PLUS_MONTH 这种不存在的名字
    // (2026-08-13 排查修复)。
    const key = paymentLinkEnvKey(planId, interval)
    return {
      success: false,
      error: `Payment link not configured for ${plan.name} ${interval}. Set ${key ?? 'STRIPE_PAYMENT_LINK_<CODE>_<MONTH|YEAR>'} in Vercel env.`,
    }
  }

  const { stripe } = await import('@/lib/stripe')
  const { headers } = await import('next/headers')

  const headersList = await headers()
  const origin = headersList.get('origin') ?? 'https://zhiyi-agent.theossindex.com'

  try {
    const session = await stripe.checkout.sessions.create({
      success_url: `${origin}/billing?success=true&plan=${planId}&interval=${interval}`,
      cancel_url: `${origin}/pricing?canceled=true`,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      allow_promotion_codes: true,
      metadata: { planId, interval },
    })

    if (!session.url) {
      return { success: false, error: 'Failed to create checkout session URL' }
    }

    return { success: true, url: session.url }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: message }
  }
}
