/**
 * WeldPass page building blocks, following the conventions of the other
 * platform modules (see `app/weldhr/components/page-kit.tsx`, which spells
 * them out):
 *
 * - List pages have NO title in the content area: `PanelEntityList` (from
 *   `@/components/panel-entity-list`) is the whole page, its top bar carries
 *   search, filters and the create button, and the breadcrumb in `AppHeader`
 *   is the title. Empty states use `emptyIcon()`.
 * - Pages split into sections use `TabsPage`: an underline `PageTabs` strip,
 *   then either a full-bleed list or content padded with `TabBody`.
 * - Overview pages use `DashboardPage`.
 * - Loading is `<PageLoader fullScreen={false} />`; confirmations use
 *   `ConfirmDialog` from `@/components/confirm-dialog`.
 */

import type { ComponentType, ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
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
 * trail, so this prepends the WeldPass root for every page.
 */
export function usePassBreadcrumbs(
  ...segments: Array<BreadcrumbSegment | null | undefined | false>
) {
  const t = useTranslations();
  useBreadcrumbs([
    { label: t('weldpass.title'), href: '/weldpass' },
    ...segments.filter((segment): segment is BreadcrumbSegment => Boolean(segment)),
  ]);
}

// ---------------------------------------------------------------------------
// Lists
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
// Tabbed pages
// ---------------------------------------------------------------------------

/**
 * A page split into sections: underline tabs across the top of the content
 * area, then the active section. List sections render an EntityList directly
 * (full bleed, it brings its own toolbar); other sections wrap themselves in
 * `TabBody` for padding.
 */
export function TabsPage({
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
      <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} overflow="dropdown" />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </div>
  );
}

/** Padded content for a non-list tab section. */
export function TabBody({
  children,
  className,
}: Readonly<{ children: ReactNode; className?: string }>) {
  return <div className={cn('space-y-6 p-6', className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** A titled card section on an overview or settings-like page. */
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

/** Quiet inline empty text for small lists inside cards (full pages use EntityList's empty state). */
export function EmptyText({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

// ---------------------------------------------------------------------------
// Overview pages
// ---------------------------------------------------------------------------

export function DashboardPage({
  title,
  description,
  actions,
  children,
}: Readonly<{
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}>) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="container mx-auto max-w-[1600px] space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-semibold">{title}</h1>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}
