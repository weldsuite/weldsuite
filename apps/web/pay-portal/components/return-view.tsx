import { buttonVariants, Button } from '@weldsuite/ui/components/button'
import { cn } from '@weldsuite/ui/lib/utils'
import type { Locale, PublicDocument } from '@/lib/contract'
import type { PortalActions } from '@/lib/actions'
import { canPay, paymentOutcome, type PaymentOutcome } from '@/lib/document-state'
import { formatMoney } from '@/lib/format'
import { dictionaries } from '@/lib/i18n'
import { PayButton } from './pay-button'

interface ReturnViewProps {
  document: PublicDocument
  locale: Locale
  /** The document page of this link. */
  backHref: string
  /** Reads the document again (the payment can settle a moment after the customer is back). */
  onRefresh: () => void
  actions: Pick<PortalActions, 'pay' | 'navigate'>
}

const TONE: Record<PaymentOutcome, string> = {
  received: 'border-emerald-600/40 bg-emerald-50 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100',
  pending: 'border-amber-600/40 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100',
  not_completed: 'border-red-600/40 bg-red-50 text-red-950 dark:bg-red-950/30 dark:text-red-100',
}

/**
 * Where Mollie sends the customer back. The document was read again for this
 * visit, so what it says is the truth: received, pending, or not completed (with
 * a way to try again).
 */
export function ReturnView({ document, locale, backHref, onRefresh, actions }: ReturnViewProps) {
  const t = dictionaries[locale]
  const outcome = paymentOutcome(document)
  const copy = outcome === 'received' ? t.return.received : outcome === 'pending' ? t.return.pending : t.return.notCompleted
  const retry = outcome === 'not_completed' && canPay(document)

  return (
    <main className="mx-auto grid max-w-xl gap-6 px-4 py-10 sm:py-16">
      <div className="grid gap-1">
        <p className="text-sm text-muted-foreground">
          {t.kind[document.kind]} {document.number} · {document.seller.name}
        </p>
        <h1 className="sr-only">{t.return.title}</h1>
      </div>
      <div role="status" data-outcome={outcome} className={cn('grid gap-1 rounded-lg border px-4 py-4', TONE[outcome])}>
        <h2 className="text-xl font-semibold">{copy.title}</h2>
        <p>{copy.body}</p>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        {retry ? (
          <PayButton
            t={t}
            label={`${t.return.tryAgain} · ${formatMoney(document.totals.balanceDue, document.currency, locale)}`}
            pay={actions.pay}
            navigate={actions.navigate}
          />
        ) : null}
        {outcome === 'pending' ? (
          <Button type="button" variant="outline" size="lg" onClick={onRefresh}>
            {t.return.refresh}
          </Button>
        ) : null}
        <a href={backHref} className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}>
          {t.return.back}
        </a>
      </div>
    </main>
  )
}
