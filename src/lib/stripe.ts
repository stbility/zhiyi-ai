'server-only'

import Stripe from 'stripe'

let _stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set')
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
  }
  return _stripe
}

// Lazy-loading proxy — `import { stripe }` keeps the same API as a Stripe instance,
// but construction is deferred until first property access (i.e., runtime, not build time).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stripeProxy = new Proxy({} as Stripe, {
  get(_target, prop) {
    const val = (getStripe() as unknown as Record<string | symbol, unknown>)[prop]
    if (typeof val === 'function') {
      return val.bind(getStripe())
    }
    return val
  },
})

export { stripeProxy as stripe }
