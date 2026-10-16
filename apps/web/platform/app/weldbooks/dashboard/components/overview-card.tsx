/**
 * One block of "Your overview", bare on the page (no border, background or
 * footer): a bold title that links to the full report or list and explains
 * the figure in a tooltip on hover, then the body.
 */

import type { ReactNode } from 'react';
import { Link, type LinkProps } from '@tanstack/react-router';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';

export function OverviewCard({
  title,
  info,
  to,
  children,
}: Readonly<{ title: string; info: string; to: LinkProps['to']; children: ReactNode }>) {
  return (
    <div className="flex min-w-0 flex-col">
      <h3 className="text-sm font-semibold">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link to={to} className="hover:underline">
              {title}
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top" align="start" className="max-w-60">
            {info}
          </TooltipContent>
        </Tooltip>
      </h3>
      <div className="mt-3 flex flex-1 flex-col">{children}</div>
    </div>
  );
}
