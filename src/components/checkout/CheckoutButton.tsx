'use client'

import { useState } from 'react'
import { startCheckout, type CheckoutError } from '@/actions/checkout'
import { Button } from '@/components/primitives/Button'
import { type PlanId } from '@/lib/plans'

interface CheckoutButtonProps {
  planId: PlanId
  interval: 'month' | 'year'
  variant?: 'primary' | 'secondary'
  children?: React.ReactNode
  className?: string
}

export function CheckoutButton({
  planId,
  interval,
  variant = 'primary',
  children,
  className,
}: CheckoutButtonProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCheckout = async () => {
    if (planId === 'free') return
    setLoading(true)
    setError(null)

    const result = await startCheckout(planId, interval)

    if (result.success) {
      window.location.href = result.url
    } else {
      setError((result as CheckoutError).error)
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant={variant}
        onClick={handleCheckout}
        disabled={loading || planId === 'free'}
        loading={loading}
        className={className}
      >
        {children ?? (interval === 'month' ? '立即订阅' : '年付订阅')}
      </Button>
      {error && (
        <p className="text-fg-tertiary text-label text-center">{error}</p>
      )}
    </div>
  )
}
