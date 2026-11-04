/**
 * WeldHR page building blocks, matching the conventions of the mature
 * platform modules (WeldBooks, WeldCommerce, WeldStash, WeldDesk). The generic
 * pieces come from the component library (`@weldsuite/ui`); this file only
 * holds what is WeldHR's own.
 *
 * - List pages have NO title in the content area: `PanelEntityList` (from
 *   `@/components/panel-entity-list`) is the whole page, its top bar carries
 *   search, filters and the create button, and the breadcrumb in `AppHeader`
 *   is the title. Empty states use `emptyIcon()`.
 * - Pages split into sections use `HrTabsPage`: an underline `PageTabs` strip,
 *   then either a full-bleed list or content padded with `TabBody`
 *   (`@weldsuite/ui/components/page-layout`).
 * - Record pages use `DetailPage` + `DetailHeader` (`page-layout`) and
 *   `DetailTabs`, with `SectionCard` and `FieldGrid` for their sections.
 * - Dashboards use `DashboardPage` (`page-layout`) + `KpiGrid`/`KpiCard`
 *   (`kpi-card`).
 * - Settings-style forms use `SettingsPage`, `SettingsSection` and
 *   `SettingRow` (`settings-layout`).
 * - Loading is `<PageLoader fullScreen={false} />`; confirmations use
 *   `ConfirmDialog` (both from `@weldsuite/ui`).
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
 * trail, so this prepends the WeldHR root for every page.
 */
export function useHrBreadcrumbs(...segments: Array<BreadcrumbSegment | null | undefined | false>) {
  const t = useTranslations();
  useBreadcrumbs([
    { label: t('weldhr.title'), href: '/weldhr' },
    ...segments.filter((s): s is BreadcrumbSegment => Boolean(s)),
  ]);
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * Column widths for WeldHR lists that hold up in a narrow pane.
 *
 * EntityList rows are a flex row of fixed-width cells, so when the pane gets
 * narrow (sidebar open, ~960px window, phone) the fixed cells shrink under
 * their content and draw over each other, and the `flex-1` cell — usually the
 * name — collapses to nothing. A list wrapped in `HrListContainer` measures
 * its own width (a CSS container query), so these classes keep the main
 * column readable, keep fixed cells at their size, and drop the secondary
 * columns (header and cells alike) once the list is too narrow for them.
 */
export const HR_COL = {
  /** The column that takes the remaining width; never narrower than a name. */
  main: 'flex-1 min-w-[140px]',
  /** A fixed width that does not shrink under its content: `${HR_COL.fixed} w-[120px]`. */
  fixed: 'shrink-0',
  /** Hidden below ~512px of list width (phones). */
  hideSm: 'hidden @lg:block',
  /** Hidden below ~672px. */
  hideMd: 'hidden @2xl:block',
  /** Hidden below ~896px. */
  hideLg: 'hidden @4xl:block',
  /** Hidden below ~1024px. */
  hideXl: 'hidden @5xl:block',
} as const;

/** The size container for a list whose columns use `HR_COL`. */
export function HrListContainer({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="@container min-w-0">{children}</div>;
}

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
 * card, then the active section. List sections render an EntityList directly
 * (full bleed, it brings its own toolbar); other sections wrap themselves in
 * `TabBody` for padding.
 */
export function HrTabsPage({
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

// ---------------------------------------------------------------------------
// Record (detail) pages
// ---------------------------------------------------------------------------

/** Underline tabs inside a `DetailPage` (same `PageTabs` as the rest of the platform). */
export function DetailTabs({
  tabs,
  activeTab,
  onTabChange,
}: Readonly<{
  tabs: PageTab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
}>) {
  return (
    <div className="-mx-6">
      <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} overflow="dropdown" />
    </div>
  );
}
