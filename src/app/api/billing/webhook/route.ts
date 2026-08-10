/**
 * Stripe Webhook 处理。
 *
 * 支持 Payment Link 和 Checkout Session 两种路径:
 *   - Payment Link: Stripe 托管结账页,完成后触发 checkout.session.completed
 *   - Checkout Session: 服务端 Session,同样触发 checkout.session.completed
 *
 * Stripe Dashboard → Developers → Webhooks:
 *   Endpoint URL: https://zhiyi-ai.vercel.app/api/billing/webhook
 *   Events: checkout.session.completed, customer.subscription.updated,
 *           customer.subscription.deleted, invoice.payment_failed
 *
 * 本地开发:
 *   stripe listen --forward-to localhost:3000/api/billing/webhook
 *   把 whsec_xxx 填入 STRIPE_WEBHOOK_SECRET env。
 */

import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe'
import { PLANS } from '@/lib/plans'

export const runtime = 'nodejs'

/** 从 session.metadata 或 Price 反查 planId + interval */
function resolvePlan(session: Record<string, unknown>): {
  planId: string | null
  interval: 'month' | 'year' | null
} {
  // 优先 metadata(Checkout Session 路径)
  const metadata = session.metadata as Record<string, string> | undefined
  if (metadata?.planId) {
    return {
      planId: metadata.planId,
      interval: (metadata.interval as 'month' | 'year') ?? null,
    }
  }

  // Payment Link 路径:从 price 反查
  const lineItems = session.line_items as { data?: Array<{ price?: { id?: string } }> } | undefined
  const priceId = lineItems?.data?.[0]?.price?.id
  if (priceId) {
    const plan = PLANS.find(
      (p) => p.priceIdMonth === priceId || p.priceIdYear === priceId,
    )
    if (plan) {
      const interval: 'month' | 'year' =
        plan.priceIdMonth === priceId ? 'month' : 'year'
      return { planId: plan.id, interval }
    }
  }

  return { planId: null, interval: null }
}

export async function POST(req: NextRequest) {
  const body = await req.text()
  const sig = req.headers.get('stripe-signature')
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  if (!sig || !webhookSecret) {
    return NextResponse.json(
      { error: 'Missing signature or webhook secret' },
      { status: 400 },
    )
  }

  let event: { type: string; data: { object: Record<string, unknown> } }
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret) as unknown as typeof event
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Webhook verification failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const customerEmail = (session.customer_email as string | undefined) ?? ''
        const customerId = (session.customer as string | undefined) ?? ''
        const subscriptionId = (session.subscription as string | undefined) ?? ''
        const { planId } = resolvePlan(session)

        if (!customerEmail || !planId) {
          console.warn('[webhook] checkout.session.completed: missing email or planId', {
            customerEmail,
            planId,
            metadata: session.metadata,
          })
          break
        }

        const { createClient } = await import('@supabase/supabase-js')
        const supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
        )

        // upsert stripe_customers
        await supabase.from('stripe_customers').upsert(
          { user_id: null, customer_id: customerId }, // user_id 待 email 查找后补充
          { onConflict: 'user_id' },
        )

        // upsert subscriptions
        if (subscriptionId) {
          await supabase.from('subscriptions').upsert(
            {
              user_id: null,
              stripe_subscription_id: subscriptionId,
              status: 'active',
              plan_id: planId,
            },
            { onConflict: 'stripe_subscription_id' },
          )
        }
        break
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object
        const customerEmail = (sub.customer_email as string | undefined) ?? ''
        const subscriptionId = (sub.id as string | undefined) ?? ''
        const status = (sub.status as string | undefined) ?? 'active'
        const planId = (sub.metadata as Record<string, string> | undefined)?.planId

        if (!customerEmail || !planId) break

        const { createClient } = await import('@supabase/supabase-js')
        const supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
        )

        if (subscriptionId) {
          await supabase.from('subscriptions').upsert(
            {
              stripe_subscription_id: subscriptionId,
              status,
              plan_id: planId,
            },
            { onConflict: 'stripe_subscription_id' },
          )
        }
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const customerEmail = (sub.customer_email as string | undefined) ?? ''
        const subscriptionId = (sub.id as string | undefined) ?? ''

        if (!customerEmail) break

        const { createClient } = await import('@supabase/supabase-js')
        const supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
        )

        if (subscriptionId) {
          await supabase.from('subscriptions').upsert(
            {
              stripe_subscription_id: subscriptionId,
              status: 'canceled',
              plan_id: 'free',
            },
            { onConflict: 'stripe_subscription_id' },
          )
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object
        console.warn('[webhook] invoice.payment_failed', {
          customerEmail: invoice.customer_email,
          invoiceId: invoice.id,
        })
        break
      }

      default:
        break
    }
  } catch (err) {
    console.error('[webhook] handler error:', err)
    // 返回 500 会让 Stripe 重试
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
