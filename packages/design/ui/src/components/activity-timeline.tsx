import type { ComponentType, ReactNode } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

export type ActivityTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export interface ActivityTimelineItem {
  id: string;
  /** What happened, in words. */
  title: ReactNode;
  /** A second line: to whom, how much, why. */
  description?: ReactNode;
  /** The moment as the reader should see it (already formatted). */
  time?: string;
  /** The same moment machine readable (ISO 8601), for `<time dateTime>`. */
  dateTime?: string;
  /** Decorative: the title names the event. */
  icon?: ComponentType<{ className?: string }>;
  /** Colours the marker. Pair it with words in the title: colour alone says nothing. */
  tone?: ActivityTone;
  /** Has not happened yet (a reminder that is scheduled). Drawn dashed and muted. */
  upcoming?: boolean;
  /** Said to screen readers in front of the title when `upcoming` or the tone needs it, e.g. "Planned:". */
  srPrefix?: string;
}

export interface ActivityTimelineProps {
  items: readonly ActivityTimelineItem[];
  /** Accessible name of the list. */
  label: string;
  className?: string;
}

const MARKER: Record<ActivityTone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  info: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400',
};

/**
 * A vertical list of what happened to a record, oldest first as given: a
 * marker on a rail, the event in words, a second line and the time. It is an
 * ordered list, so a screen reader announces "3 of 5"; events that are still
 * to come (`upcoming`) are drawn dashed. It holds no translations: every word
 * comes from props.
 */
export function ActivityTimeline({ items, label, className }: Readonly<ActivityTimelineProps>) {
  return (
    <ol aria-label={label} className={cn('m-0 list-none p-0', className)}>
      {items.map((item, index) => {
        const Icon = item.icon;
        const last = index === items.length - 1;
        const tone = item.tone ?? 'neutral';
        return (
          <li
            key={item.id}
            data-upcoming={item.upcoming ? '' : undefined}
            className="relative flex gap-3 pb-4 last:pb-0"
          >
            {last ? null : (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute top-6 bottom-0 left-3 w-px -translate-x-1/2',
                  item.upcoming ? 'border-l border-dashed border-border' : 'bg-border',
                )}
              />
            )}
            <span
              aria-hidden="true"
              className={cn(
                'relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-full border [&_svg]:size-3.5',
                item.upcoming ? 'border-dashed border-border bg-background text-muted-foreground' : MARKER[tone],
              )}
            >
              {Icon ? <Icon className="size-3.5" /> : <span className="size-1.5 rounded-full bg-current" />}
            </span>
            <div className={cn('min-w-0 flex-1 pt-0.5', item.upcoming && 'text-muted-foreground')}>
              <p className="text-sm leading-snug font-medium text-pretty">
                {item.srPrefix ? <span className="sr-only">{item.srPrefix} </span> : null}
                {item.title}
              </p>
              {item.description ? (
                <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground text-pretty">{item.description}</p>
              ) : null}
              {item.time ? (
                <time dateTime={item.dateTime} className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
                  {item.time}
                </time>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
