'use server'

import { PLANS, type PlanId } from '@/lib/plans'

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
    return {
      success: false,
      error: `Payment link not configured for ${plan.name} ${interval}. Set STRIPE_PAYMENT_LINK_${plan.id.toUpperCase()}_${interval.toUpperCase()} in Vercel env.`,
    }
  }

  const { stripe } = await import('@/lib/stripe')
  const { headers } = await import('next/headers')

  const headersList = await headers()
  const origin = headersList.get('origin') ?? 'https://zhiyi-ai.vercel.app'

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
