/**
 * The card a chart shows for the thing under the pointer, as on dub.co's
 * analytics: a title, then its rows (usually `ChartTooltipRow`s) right under
 * it. The chart places it; the card only draws.
 */

import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

export interface ChartHoverCardProps extends Omit<ComponentProps<'div'>, 'title'> {
  title: ReactNode;
}

export function ChartHoverCard({ title, children, className, ...props }: Readonly<ChartHoverCardProps>) {
  return (
    <div className={cn('min-w-40 rounded-lg border bg-background text-sm shadow-sm', className)} {...props}>
      <p className="px-3 pt-2 text-foreground">{title}</p>
      <div className="grid gap-1.5 px-3 pt-1 pb-2">{children}</div>
    </div>
  );
}
