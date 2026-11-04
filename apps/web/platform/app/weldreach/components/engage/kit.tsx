/**
 * Building blocks shared by the WeldReach campaign, prospect and inbox pages.
 * They follow the platform conventions (see `app/weldhr/components/page-kit.tsx`):
 * lists are a `PanelEntityList` with the breadcrumb as the title, record pages
 * use `DetailHeader` (`@weldsuite/ui/components/page-layout`) with `DetailTabs`,
 * loading is `PageLoader` / `InlineSpinner`, failures are `ErrorBanner`,
 * notices are `InfoBanner`, confirmations use `ConfirmDialog` and list filters
 * use `FilterSelect` (all from `@weldsuite/ui`).
 */

import type { ComponentType, ReactNode } from 'react';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { useTranslations } from '@weldsuite/i18n/client';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useBreadcrumbs, type BreadcrumbSegment } from '@/contexts/breadcrumb-context';

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

// ---------------------------------------------------------------------------
// Record pages
// ---------------------------------------------------------------------------

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
