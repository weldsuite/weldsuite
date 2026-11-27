import { cn } from '@weldsuite/ui/lib/utils'
import type { PublicDocument } from '@/lib/contract'
import type { BannerKind } from '@/lib/document-state'
import { formatDate, formatMoney } from '@/lib/format'
import type { Dictionary } from '@/lib/i18n'

const TONE: Record<BannerKind, string> = {
  paid: 'border-emerald-600/40 bg-emerald-50 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100',
  accepted: 'border-emerald-600/40 bg-emerald-50 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100',
  partially_paid: 'border-amber-600/40 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100',
  pending: 'border-amber-600/40 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100',
  overdue: 'border-red-600/40 bg-red-50 text-red-950 dark:bg-red-950/30 dark:text-red-100',
  cancelled: 'border-border bg-muted text-foreground',
  declined: 'border-border bg-muted text-foreground',
  expired: 'border-border bg-muted text-foreground',
}

/** The words of a banner, in the document's language. */
export function bannerText(t: Dictionary, kind: BannerKind, document: PublicDocument, locale: 'en' | 'nl'): { title: string; body: string } {
  switch (kind) {
    case 'paid':
      return t.status.paid
    case 'partially_paid':
      return t.status.partiallyPaid(formatMoney(document.totals.balanceDue, document.currency, locale))
    case 'overdue':
      return t.status.overdue(document.dueDate ? formatDate(document.dueDate, locale) : '')
    case 'cancelled':
      return t.status.cancelled
    case 'pending':
      return t.status.pending
    case 'accepted':
      return t.status.accepted
    case 'declined':
      return t.status.declined
    case 'expired':
      return t.status.expired(document.validUntil ? formatDate(document.validUntil, locale) : null)
  }
}

export function StatusBanner({ kind, title, body }: { kind: BannerKind; title: string; body: string }) {
  return (
    <div role="status" data-banner={kind} className={cn('grid gap-0.5 rounded-lg border px-4 py-3', TONE[kind])}>
      <p className="font-semibold">{title}</p>
      <p className="text-sm">{body}</p>
    </div>
  )
}
