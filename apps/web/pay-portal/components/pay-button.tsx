import { useRef, useState } from 'react'
import { Button } from '@weldsuite/ui/components/button'
import type { FailureReason, Result } from '@/lib/contract'
import type { Dictionary } from '@/lib/i18n'

export function payFailureText(t: Dictionary, reason: FailureReason): string {
  switch (reason) {
    case 'conflict':
      return t.pay.conflict
    case 'unavailable':
      return t.pay.unavailable
    case 'rate_limited':
      return t.pay.rateLimited
    case 'not_found':
      return t.pay.notFound
    default:
      return t.pay.generic
  }
}

interface PayButtonProps {
  t: Dictionary
  label: string
  /** Creates the Mollie payment: its checkout address, or why not. */
  pay: () => Promise<Result<{ checkoutUrl: string }>>
  /** Leaves for Mollie's checkout. */
  navigate: (url: string) => void
}

/**
 * Pay now. While the payment is being made the button says so and cannot be
 * pressed again: the ref closes the gap before React has re-rendered the
 * disabled button, so two quick taps make one payment. After a successful call the
 * button stays busy: the page is about to be left.
 */
export function PayButton({ t, label, pay, navigate }: PayButtonProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  async function start() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    const result = await pay().catch((): Result<{ checkoutUrl: string }> => ({ ok: false, reason: 'network' }))
    if (result.ok) {
      navigate(result.data.checkoutUrl)
      return
    }
    setError(payFailureText(t, result.reason))
    inFlight.current = false
    setBusy(false)
  }

  return (
    <div className="grid gap-2">
      <Button type="button" size="lg" className="w-full sm:w-auto" disabled={busy} aria-busy={busy} onClick={start}>
        {busy ? <progress className="loading-spinner" aria-label={t.actions.paying} /> : null}
        {busy ? t.actions.paying : label}
      </Button>
      {/* The busy state is announced; the error below is an alert of its own. */}
      <p role="status" className="sr-only">
        {busy ? t.actions.paying : ''}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
