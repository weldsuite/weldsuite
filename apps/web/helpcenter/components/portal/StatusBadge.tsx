import clsx from 'clsx'
import type { DeskPortalStatus } from '@weldsuite/app-api-client/schemas/desk-portal'
import type { PortalStrings } from '@/lib/portal-i18n'

const tone: Record<DeskPortalStatus, string> = {
  submitted: 'bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700',
  in_progress: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30',
  waiting_on_customer:
    'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  resolved:
    'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
}

interface StatusBadgeProps {
  status: DeskPortalStatus
  /** The ticket type's own customer wording; null = the help center's default. */
  label: string | null
  t: PortalStrings
}

export function StatusBadge({ status, label, t }: Readonly<StatusBadgeProps>) {
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        tone[status] ?? tone.submitted,
      )}
    >
      {label || t.status[status] || status}
    </span>
  )
}
