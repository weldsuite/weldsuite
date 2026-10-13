/**
 * Building blocks shared by the WeldReach campaign, prospect and inbox pages.
 * They follow the platform conventions (see `app/weldpass/components/page-kit.tsx`
 * and `app/weldhr/components/page-kit.tsx`): lists are a `PanelEntityList` with
 * the breadcrumb as the title, record pages use a detail header with underline
 * tabs, loading is `PageLoader`, confirmations use `ConfirmDialog`.
 */

import type { ComponentType, ReactNode } from 'react';
import { AlertTriangle, ChevronLeft, Loader2, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { useTranslations } from '@weldsuite/i18n/client';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useBreadcrumbs, type BreadcrumbSegment } from '@/contexts/breadcrumb-context';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

/**
 * Set the AppHeader breadcrumb trail. `useBreadcrumbs` replaces the whole
 * trail, so this prepends the WeldReach root to every page.
 */
export function useReachBreadcrumbs(
  ...segments: Array<BreadcrumbSegment | null | undefined | false>
) {
  const t = useTranslations();
  useBreadcrumbs([
    { label: t('reach.title'), href: '/weldreach' },
    ...segments.filter((segment): segment is BreadcrumbSegment => Boolean(segment)),
  ]);
}

// ---------------------------------------------------------------------------
// Lists and empty states
// ---------------------------------------------------------------------------

/** The empty-state icon every EntityList page uses. */
export function emptyIcon(Icon: ComponentType<{ className?: string; strokeWidth?: number }>) {
  return (
    <EmptyStateIllustration>
      <Icon className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
    </EmptyStateIllustration>
  );
}

/** Quiet inline empty text for small lists inside cards. */
export function EmptyText({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

export function InlineSpinner({ className }: Readonly<{ className?: string }>) {
  return (
    <div
      className={cn(
        'flex items-center justify-center py-10 text-sm text-muted-foreground',
        className,
      )}
    >
      <Loader2 className="h-4 w-4 animate-spin" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** A server message without its closing full stop, to embed in a longer sentence. */
export function withoutTrailingPeriod(message: string): string {
  let end = message.length;
  while (end > 0 && (message[end - 1] === '.' || message[end - 1] === ' ')) end -= 1;
  return message.slice(0, end);
}

export function ErrorBanner({
  error,
  onDismiss,
  className,
}: Readonly<{
  error: string | null;
  onDismiss?: () => void;
  className?: string;
}>) {
  const t = useTranslations();
  if (!error) return null;
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="flex-1 break-words">{error}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('reachEngage.common.dismiss')}
          className="shrink-0"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** A neutral or warning notice with the same shape as the error banner. */
export function Notice({
  tone = 'info',
  title,
  children,
  className,
}: Readonly<{
  tone?: 'info' | 'warning';
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}>) {
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2 text-sm',
        tone === 'warning'
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
          : 'border-border bg-muted/40 text-muted-foreground',
        className,
      )}
    >
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={cn(title && 'mt-0.5')}>{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Record pages
// ---------------------------------------------------------------------------

/** Padded content for a tab section. */
export function TabBody({
  children,
  className,
}: Readonly<{ children: ReactNode; className?: string }>) {
  return <div className={cn('space-y-6 p-6', className)}>{children}</div>;
}

/** Title row of a record page: back button, title, badges, actions on the right. */
export function DetailHeader({
  title,
  subtitle,
  badges,
  actions,
  onBack,
}: Readonly<{
  title: ReactNode;
  subtitle?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  onBack?: () => void;
}>) {
  const t = useTranslations();
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 px-6 pt-6">
      <div className="flex min-w-0 items-start gap-3">
        {onBack && (
          <Button
            variant="outline"
            size="icon"
            onClick={onBack}
            className="mt-0.5 h-8 w-8 shrink-0 text-muted-foreground shadow-none"
            aria-label={t('reachEngage.common.back')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        )}
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

/** Underline tabs under a record header, then the active section. */
export function DetailTabs({
  tabs,
  activeTab,
  onTabChange,
  children,
}: Readonly<{
  tabs: PageTab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  children: ReactNode;
}>) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-6 pt-4">
        <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} overflow="dropdown" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </div>
  );
}

/** A titled card section. */
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
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-3">
        <div className="min-w-0 space-y-1">
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
// Filters
// ---------------------------------------------------------------------------

/** Radix selects reject an empty item value, so "no filter" is this sentinel. */
export const ALL_VALUE = '__all__';

export interface FilterSelectOption {
  value: string;
  label: string;
}

/**
 * A compact "all or one value" filter for list toolbars. `value` is the
 * active value, or `undefined` for no filter.
 */
export function FilterSelect({
  value,
  onChange,
  options,
  allLabel,
  ariaLabel,
  className,
}: Readonly<{
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: FilterSelectOption[];
  allLabel: string;
  ariaLabel: string;
  className?: string;
}>) {
  return (
    <Select
      value={value ?? ALL_VALUE}
      onValueChange={(next) => onChange(next === ALL_VALUE ? undefined : next)}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel} className={cn('h-8 w-auto min-w-[8rem] shadow-none', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_VALUE}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
