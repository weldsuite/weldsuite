import { useId, type ReactNode } from 'react'
import { cn } from '@weldsuite/ui/lib/utils'
import type { PortalStatusColour } from '@weldsuite/app-api-client/schemas/project-portal'
import { initials } from '@/lib/format'
import type { Tone } from '@/lib/labels'

/** Small pieces several sections share: a titled card, a status chip, a tile. */

export type ChipTone = Tone | 'info'

const CHIP_TONES: Record<ChipTone, { box: string; dot: string }> = {
  neutral: { box: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' },
  good: { box: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' },
  warn: { box: 'bg-amber-500/10 text-amber-700 dark:text-amber-400', dot: 'bg-amber-500' },
  bad: { box: 'bg-red-500/10 text-red-700 dark:text-red-400', dot: 'bg-red-500' },
  info: { box: 'bg-blue-500/10 text-blue-700 dark:text-blue-400', dot: 'bg-blue-500' },
}

/** The tone of a report colour; the colour is always also written out in the chip's text. */
export function colourTone(colour: PortalStatusColour): ChipTone {
  switch (colour) {
    case 'green':
      return 'good'
    case 'amber':
      return 'warn'
    case 'red':
      return 'bad'
    default:
      return 'neutral'
  }
}

export function Chip({
  tone = 'neutral',
  dot = false,
  className,
  children,
}: Readonly<{ tone?: ChipTone; dot?: boolean; className?: string; children: ReactNode }>) {
  const classes = CHIP_TONES[tone]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        classes.box,
        className,
      )}
    >
      {dot && <span aria-hidden="true" className={cn('size-1.5 rounded-full', classes.dot)} />}
      {children}
    </span>
  )
}

/** A white card with a heading; `action` sits at the right of the heading. */
export function Section({
  title,
  action,
  className,
  children,
}: Readonly<{ title: string; action?: ReactNode; className?: string; children: ReactNode }>) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className={cn('min-w-0 rounded-xl border bg-card p-4 sm:p-5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-[15px] font-semibold">
          {title}
        </h2>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

export function EmptyText({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

/** A person's initials in a round mark; the name is always written next to it. */
export function Avatar({ name, className }: Readonly<{ name: string; className?: string }>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-foreground',
        className,
      )}
    >
      {initials(name)}
    </span>
  )
}
