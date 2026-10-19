/**
 * One block of "Your overview", bare on the page (no border, background or
 * footer): a title, in the figures' regular weight, that links to the full report or list and explains
 * the figure in a tooltip on hover, then the body. A user's own chart has no
 * link when it has no description, and carries its menu (`actions`) on the
 * title row.
 */

import type { ReactNode } from 'react';
import { Link, type LinkProps } from '@tanstack/react-router';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';

export function OverviewCard({
  title,
  info,
  to,
  actions,
  children,
}: Readonly<{ title: string; info?: string; to?: LinkProps['to']; actions?: ReactNode; children: ReactNode }>) {
  const heading = to ? (
    <Link to={to} className="hover:underline">
      {title}
    </Link>
  ) : (
    <span>{title}</span>
  );

  return (
    <div className="group/card flex min-w-0 flex-col">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm">
          {info ? (
            <Tooltip>
              <TooltipTrigger asChild>{heading}</TooltipTrigger>
              <TooltipContent side="top" align="start" className="max-w-60">
                {info}
              </TooltipContent>
            </Tooltip>
          ) : (
            heading
          )}
        </h3>
        {actions}
      </div>
      <div className="mt-3 flex flex-1 flex-col">{children}</div>
    </div>
  );
}
