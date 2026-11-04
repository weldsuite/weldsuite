'use client';

/**
 * Page shells shared by the platform modules:
 *
 * - `DashboardPage`: a scrolling overview with a title row (title,
 *   description, actions) above KPI tiles and section cards.
 * - `DetailPage` + `DetailHeader`: a record page; the header holds an
 *   optional back button, avatar/icon, title, badges, subtitle and actions.
 * - `TabBody`: padded content for a tab section that is not a full-bleed list.
 */

import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useUiLabels } from '@weldsuite/ui/providers/ui-labels-provider';
import { cn } from '@weldsuite/ui/lib/utils';

export interface DashboardPageProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Classes for the centred content column (width, padding). */
  className?: string;
}

/** A scrolling overview page: a title row, then the content, centred up to 1600px. */
export function DashboardPage({ title, description, actions, children, className }: Readonly<DashboardPageProps>) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cn('container mx-auto max-w-[1600px] space-y-6 p-6', className)}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-semibold">{title}</h1>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** The scrolling, padded body of a record page. */
export function DetailPage({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cn('space-y-6 p-6', className)}>{children}</div>
    </div>
  );
}

export interface DetailHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** An avatar or icon before the title. */
  leading?: ReactNode;
  /** Badges after the title, on the same line. */
  badges?: ReactNode;
  /** Buttons on the right. */
  actions?: ReactNode;
  /** Shows a back button before everything else. */
  onBack?: () => void;
  /** Accessible name of the back button. Defaults to the `back` label of `UiLabelsProvider`. */
  backLabel?: string;
  className?: string;
}

/** The title row of a record page: back button, avatar/icon, `text-2xl` title, badges, subtitle, actions. */
export function DetailHeader({
  title,
  subtitle,
  leading,
  badges,
  actions,
  onBack,
  backLabel,
  className,
}: Readonly<DetailHeaderProps>) {
  const labels = useUiLabels();
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className={cn('flex min-w-0 items-start', onBack && !leading ? 'gap-3' : 'gap-4')}>
        {onBack && (
          <Button
            variant="outline"
            size="icon"
            onClick={onBack}
            className="mt-0.5 h-8 w-8 shrink-0 text-muted-foreground shadow-none"
            aria-label={backLabel ?? labels.back}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        )}
        {leading}
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold">{title}</h1>
            {badges}
          </div>
          {subtitle && <div className="text-sm text-muted-foreground">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Padded content for a tab section that is not a full-bleed list. */
export function TabBody({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <div className={cn('space-y-6 p-6', className)}>{children}</div>;
}
