/**
 * Cell content for WeldBooks list rows, in the WeldFlow task-row style
 * (`app/weldflow/my-tasks/my-tasks-client.tsx`): a bold title with small chips,
 * muted secondary text, monospaced dates, a rounded-square avatar for people
 * and companies, and coloured status chips instead of shadcn badges.
 *
 * Every WeldBooks list renders its `ColumnDef.render` output with these, so the
 * lists look the same as each other and as the task list.
 */

import type { ReactNode } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { cn } from '@/lib/utils';

export type ChipTone = 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'indigo';

/** Colours of the task-row status chip, per tone. */
const TONE_CLASSES: Record<ChipTone, string> = {
  gray: 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary',
  blue: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950',
  green: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950',
  amber: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950',
  red: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950',
  purple: 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950',
  indigo: 'text-indigo-700 dark:text-indigo-400 bg-indigo-100 dark:bg-indigo-900/30',
};

/**
 * Default tone of the lifecycle statuses WeldBooks records share. A page whose
 * statuses mean something else passes its own tone to `StatusChip`.
 */
const STATUS_TONES: Record<string, ChipTone> = {
  // done / settled
  paid: 'green',
  posted: 'green',
  active: 'green',
  reconciled: 'green',
  matched: 'green',
  completed: 'green',
  filed: 'green',
  accepted: 'green',
  approved: 'blue',
  // in flight
  sent: 'blue',
  finalized: 'blue',
  open: 'blue',
  submitted: 'blue',
  processing: 'blue',
  issued: 'blue',
  partial: 'amber',
  partially_paid: 'amber',
  pending: 'amber',
  paused: 'amber',
  review: 'amber',
  needs_review: 'amber',
  due: 'amber',
  // problems
  overdue: 'red',
  failed: 'red',
  rejected: 'red',
  error: 'red',
  // inactive
  draft: 'gray',
  void: 'gray',
  voided: 'gray',
  cancelled: 'gray',
  canceled: 'gray',
  closed: 'gray',
  archived: 'gray',
  inactive: 'gray',
  locked: 'purple',
};

export function statusTone(status: string | null | undefined): ChipTone {
  return (status && STATUS_TONES[status]) || 'gray';
}

/** The bold row title, with optional chips (number, frequency, …) after it. */
export function RowTitle({ children, chips }: Readonly<{ children: ReactNode; chips?: ReactNode }>) {
  return (
    <>
      <span className="text-sm font-medium truncate min-w-0 text-gray-900 dark:text-foreground">{children}</span>
      {chips}
    </>
  );
}

/** Small mono chip in front of a title, like the task number badge (invoice / bill numbers, account codes). */
export function RowNumberChip({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <span className="inline-flex h-[18px] flex-shrink-0 items-center rounded-[5px] bg-gray-100 px-1.5 font-mono text-[11px] font-medium text-gray-600 dark:bg-secondary dark:text-muted-foreground">
      {children}
    </span>
  );
}

/** Small tinted chip after a title, like the task repeat / label chips. */
export function RowChip({
  children,
  icon,
  tone = 'indigo',
}: Readonly<{ children: ReactNode; icon?: ReactNode; tone?: ChipTone }>) {
  return (
    <span
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium [&_svg]:h-2.5 [&_svg]:w-2.5',
        TONE_CLASSES[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** The coloured status chip of the task row. */
export function StatusChip({
  children,
  status,
  tone,
}: Readonly<{ children: ReactNode; status?: string | null; tone?: ChipTone }>) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded px-2 py-0.5 text-[12px] font-medium',
        TONE_CLASSES[tone ?? statusTone(status)],
      )}
    >
      {children}
    </span>
  );
}

/** The dash an empty cell shows. */
export function EmptyCell() {
  return <span className="text-sm text-gray-400">—</span>;
}

/** Muted secondary text; a dash when empty. */
export function RowText({ children, className }: Readonly<{ children?: ReactNode; className?: string }>) {
  if (children === null || children === undefined || children === '') return <EmptyCell />;
  return (
    <span className={cn('block truncate text-sm text-gray-600 dark:text-muted-foreground', className)}>{children}</span>
  );
}

/** A date, monospaced like the task due date; a dash when empty. Pass the formatted string. */
export function RowDate({ children, className }: Readonly<{ children?: string | null; className?: string }>) {
  if (!children || children === '—') return <EmptyCell />;
  return (
    <span className={cn('whitespace-nowrap font-mono text-sm text-gray-600 dark:text-muted-foreground', className)}>
      {children}
    </span>
  );
}

/** A money amount. Pass the formatted string. */
export function RowAmount({ children, className }: Readonly<{ children?: ReactNode; className?: string }>) {
  if (children === null || children === undefined || children === '') return <EmptyCell />;
  return <span className={cn('whitespace-nowrap text-sm tabular-nums', className)}>{children}</span>;
}

/** The 20px rounded-square avatar of the task assignee: the image when there is one, else the initial. */
export function RowAvatar({ name, src }: Readonly<{ name: string; src?: string | null }>) {
  return (
    <Avatar className="h-5 w-5 flex-shrink-0 !rounded-[7px]">
      {src ? <AvatarImage src={src} alt={name} className="!rounded-[7px]" /> : null}
      <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
        {name.charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/** A person or company: avatar, then the name. A dash when unknown. */
export function ContactCell({ name, src }: Readonly<{ name?: string | null; src?: string | null }>) {
  if (!name) return <EmptyCell />;
  return (
    <>
      <RowAvatar name={name} src={src} />
      <span className="ml-1.5 truncate text-sm text-gray-600 dark:text-muted-foreground">{name}</span>
    </>
  );
}
