/**
 * WeldReach page building blocks, shared by every screen of the module
 * (overview, setup, mailboxes, settings, and the campaign, prospect and inbox
 * pages): breadcrumbs, dashboard shell, KPI tiles, section cards and the
 * loading / error / empty states every data-driven screen needs.
 */

import type { ComponentType, ReactNode } from 'react';
import { Link } from '@/lib/router';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import { useBreadcrumbs, type BreadcrumbSegment } from '@/contexts/breadcrumb-context';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

/**
 * Set the AppHeader breadcrumb trail. `useBreadcrumbs` replaces the whole
 * trail, so this prepends the WeldReach root for every page.
 */
export function useReachBreadcrumbs(...segments: Array<BreadcrumbSegment | null | undefined | false>) {
  const t = useTranslations();
  useBreadcrumbs([
    { label: t('reach.title'), href: '/weldreach' },
    ...segments.filter((segment): segment is BreadcrumbSegment => Boolean(segment)),
  ]);
}

// ---------------------------------------------------------------------------
// Page shells
// ---------------------------------------------------------------------------

/** Scrollable page with a title row: overview and setup. */
export function DashboardPage({
  title,
  description,
  actions,
  children,
  className,
}: Readonly<{
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}>) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cn('container mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6', className)}>
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

/** A titled card section on an overview or settings page. */
export function SectionCard({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
}: Readonly<{
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}>) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0 pb-3">
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          <CardTitle className="text-base font-semibold">{title}</CardTitle>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------

export function KpiGrid({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

export function KpiCard({
  label,
  value,
  icon: Icon,
  hint,
  tone,
  href,
}: Readonly<{
  label: string;
  value: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  hint?: ReactNode;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  /** Makes the whole tile a link (for example unread replies to the inbox). */
  href?: string;
}>) {
  const card = (
    <Card className={cn('h-full', href && 'transition-colors hover:bg-accent/40')}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            'text-2xl font-bold tabular-nums',
            tone === 'warning' && 'text-amber-600 dark:text-amber-400',
            tone === 'danger' && 'text-destructive',
            tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
          )}
        >
          {value}
        </div>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
  if (!href) return card;
  return (
    <Link href={href} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {card}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** Quiet inline empty text for small lists inside cards. */
export function EmptyText({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

/** An empty list with a call to action. */
export function EmptyPanel({
  icon: Icon,
  title,
  description,
  action,
}: Readonly<{
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}>) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
      {Icon && <Icon className="h-8 w-8 text-muted-foreground/60" />}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

/** A failed load, with a retry. */
export function ErrorPanel({ message, onRetry }: Readonly<{ message?: string; onRetry?: () => void }>) {
  const t = useTranslations();
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-8 text-center"
    >
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <p className="text-sm text-destructive">{message ?? t('reach.common.loadError')}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('reach.common.retry')}
        </Button>
      )}
    </div>
  );
}

/** A small inline error line under a control. */
export function InlineError({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="text-sm text-destructive">{children}</p>;
}
