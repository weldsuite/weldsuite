import type { ComponentProps } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

/** The count as shown: a number above `max` reads "99+", a string is shown as given. */
export function formatCount(count: number | string, max = 99): string {
  if (typeof count === 'string') return count;
  return count > max ? `${max}+` : String(count);
}

/** A circle for one character, wider for two, wider still for "99+". */
function sizeClass(text: string): string {
  if (text.length > 2) return 'min-w-[30px] px-[4px]';
  if (text.length === 2) return 'min-w-[24px] px-[4px]';
  return 'w-[18px]';
}

export interface CountBadgeProps extends Omit<ComponentProps<'span'>, 'children'> {
  /** Unread, pending or mention count; nothing renders at 0. */
  count: number | string;
  /** Highest number written out; above it the badge reads "{max}+". */
  max?: number;
  /** Spoken name ("3 unread"), when the number alone says too little. */
  label?: string;
}

/**
 * The red unread count: a circle for one digit, a pill for more. Used on the
 * app rail icons and next to module sidebar items, so counts read the same
 * everywhere. Placement (a corner of an icon, the end of a row) is up to the
 * caller's `className`.
 */
export function CountBadge({ count, max = 99, label, className, ...props }: Readonly<CountBadgeProps>) {
  if (count === '' || (typeof count === 'number' && count <= 0)) return null;
  const text = formatCount(count, max);
  return (
    <span
      data-slot="count-badge"
      className={cn(
        'flex h-[18px] shrink-0 items-center justify-center rounded-full bg-red-500 text-[11px] font-semibold leading-none tabular-nums text-white',
        sizeClass(text),
        className,
      )}
      {...props}
    >
      {label ? (
        <>
          <span aria-hidden="true">{text}</span>
          <span className="sr-only">{label}</span>
        </>
      ) : (
        text
      )}
    </span>
  );
}
