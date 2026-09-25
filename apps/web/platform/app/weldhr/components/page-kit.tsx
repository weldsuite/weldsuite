/**
 * WeldHR page building blocks, matching the conventions of the mature
 * platform modules (WeldBooks, WeldCommerce, WeldStash, WeldDesk):
 *
 * - List pages have NO title in the content area: `PanelEntityList` (from
 *   `@/components/panel-entity-list`) is the whole page, its top bar carries
 *   search, filters and the create button, and the breadcrumb in `AppHeader`
 *   is the title. Empty states use `emptyIcon()`.
 * - Pages split into sections use `HrTabsPage`: an underline `PageTabs` strip,
 *   then either a full-bleed list or padded content.
 * - Record pages use `DetailPage` + `DetailHeader` (+ `DetailTabs`), like
 *   `app/weldbooks/invoices/[id]`.
 * - Dashboards use `DashboardPage` + `KpiGrid`/`KpiCard`, like
 *   `app/weldstash/page.tsx` and `app/weldbooks/dashboard`.
 * - Settings-style forms use `SettingsPage` (+ `SettingsSection`,
 *   `SettingRow`), like `app/welddesk/settings/settings-client.tsx`.
 * - Loading is `<PageLoader fullScreen={false} />`; confirmations use
 *   `ConfirmDialog` from `@/components/confirm-dialog`.
 */

import type { ComponentType, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
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

/** Padded content for a non-list tab section. */
export function TabBody({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <div className={cn('p-6 space-y-6', className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Record (detail) pages
// ---------------------------------------------------------------------------

export function DetailPage({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 space-y-6">{children}</div>
    </div>
  );
}

/** Title row of a record page: avatar/icon, `text-2xl` title, badges, subtitle, actions on the right. */
export function DetailHeader({
  title,
  subtitle,
  leading,
  badges,
  actions,
}: Readonly<{
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
}>) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-4">
        {leading}
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold truncate">{title}</h1>
            {badges}
          </div>
          {subtitle && <div className="text-sm text-muted-foreground">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Underline tabs inside a record page (same `PageTabs` as the rest of the platform). */
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

/** A titled card section on a record or dashboard page. */
export function SectionCard({
  title,
  action,
  children,
  className,
  contentClassName,
}: Readonly<{
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}>) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}

/** Label/value pairs in a record's detail card. */
export function FieldGrid({ fields }: Readonly<{ fields: Array<{ label: string; value: ReactNode }> }>) {
  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
      {fields.map((field) => (
        <div key={field.label} className="space-y-1">
          <dt className="text-xs text-muted-foreground">{field.label}</dt>
          <dd className="text-sm">{field.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Quiet inline empty text for small lists inside cards (not full pages — those use EntityList's empty state). */
export function EmptyText({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export function DashboardPage({ title, actions, children }: Readonly<{ title: ReactNode; actions?: ReactNode; children: ReactNode }>) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="container mx-auto max-w-[1600px] p-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function KpiGrid({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

/** Same markup as the KPI cards in WeldStash / WeldBooks. */
export function KpiCard({
  label,
  value,
  icon: Icon,
  hint,
  tone,
}: Readonly<{
  label: string;
  value: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  hint?: ReactNode;
  tone?: 'default' | 'warning' | 'danger' | 'success';
}>) {
  return (
    <Card>
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
}

// ---------------------------------------------------------------------------
// Settings-style forms
// ---------------------------------------------------------------------------

/**
 * WeldDesk-style settings page: sticky header with title, description and a
 * single Save (enabled when there are changes), body `max-w-2xl` sections.
 */
export function SettingsPage({
  title,
  description,
  hasChanges,
  saving,
  onSave,
  onCancel,
  children,
}: Readonly<{
  title: ReactNode;
  description?: ReactNode;
  hasChanges: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel?: () => void;
  children: ReactNode;
}>) {
  const t = useTranslations();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button variant="outline" size="sm" onClick={onCancel} disabled={!hasChanges || saving}>
              {t('weldhr.common.cancel')}
            </Button>
          )}
          <Button size="sm" onClick={onSave} disabled={!hasChanges || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('weldhr.common.save')}
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-10 px-4 py-10">{children}</div>
      </div>
    </div>
  );
}

export function SettingsSection({ title, description, children }: Readonly<{ title: ReactNode; description?: ReactNode; children: ReactNode }>) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** A labelled row with a control on the right (Switch, Select…). */
export function SettingRow({ label, description, children }: Readonly<{ label: ReactNode; description?: ReactNode; children: ReactNode }>) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="space-y-1">
        <p className="text-sm font-medium">{label}</p>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
