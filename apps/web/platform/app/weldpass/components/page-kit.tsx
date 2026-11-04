/**
 * WeldPass page building blocks, following the conventions of the other
 * platform modules (see `app/weldhr/components/page-kit.tsx`, which spells
 * them out):
 *
 * - List pages have NO title in the content area: `PanelEntityList` (from
 *   `@/components/panel-entity-list`) is the whole page, its top bar carries
 *   search, filters and the create button, and the breadcrumb in `AppHeader`
 *   is the title. Empty states use `emptyIcon()`.
 * - Detail pages split into sections use `TabsPage`: a toolbar row (back
 *   button, plus the section's search and buttons) and the underline tab strip
 *   of the WeldMeet meeting page, then either a full-bleed list or content
 *   padded with `TabBody`.
 * - Overview pages use `DashboardPage`, `TabBody` pads a non-list section and
 *   `SectionCard` / `EmptyText` build its content (all from `@weldsuite/ui`).
 * - Loading is `<PageLoader fullScreen={false} />`; confirmations use
 *   `ConfirmDialog` (both from `@weldsuite/ui`).
 */

import type { ComponentType, ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ListToolbar, type ListToolbarProps } from '@weldsuite/ui/components/list-toolbar';
import type { PageTab } from '@weldsuite/ui/components/page-tabs';
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

/** What a section adds to the toolbar row: search and buttons. */
export type TabsPageToolbar = Omit<ListToolbarProps, 'className'>;

/**
 * A detail page split into sections: a toolbar row, then underline tabs (the
 * strip of the WeldMeet meeting page), then the active section. The toolbar
 * always starts with the back button; a list section adds its search and
 * buttons to it through `toolbar` and renders its EntityList full bleed with
 * the built-in top bar hidden. Other sections wrap themselves in `TabBody`.
 */
export function TabsPage({
  onBack,
  toolbar,
  tabs,
  activeTab,
  onTabChange,
  children,
}: Readonly<{
  onBack: () => void;
  toolbar?: TabsPageToolbar;
  tabs: PageTab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  children: ReactNode;
}>) {
  const t = useTranslations();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ListToolbar
        {...toolbar}
        className="flex-shrink-0 bg-white dark:bg-background"
        leftActionButtons={
          <>
            <Button
              variant="outline"
              size="icon"
              onClick={onBack}
              className="h-8 w-8 shadow-none text-muted-foreground"
              aria-label={t('common.actions.back')}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {toolbar?.leftActionButtons}
          </>
        }
      />

      <div className="flex-shrink-0 overflow-hidden bg-white px-4 pt-[10px] dark:bg-background">
        <div role="tablist" className="mb-[10px] flex items-center gap-1">
          {tabs.map((tab, index) => {
            const isFirst = index === 0;
            const isActive = tab.id === activeTab;
            const TabIcon = tab.icon;
            return (
              <div key={tab.id} className="group relative">
                <Button
                  variant="ghost"
                  size="sm"
                  role="tab"
                  aria-selected={isActive}
                  className={cn(
                    'text-xs hover:bg-transparent md:text-sm',
                    isFirst ? '!pl-0 pr-2 md:pr-3' : 'px-2 md:px-3',
                    isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => onTabChange(tab.id)}
                >
                  {TabIcon && <TabIcon className="mr-0.5 h-3 w-3" />}
                  {tab.label}
                </Button>
                <div
                  className={cn(
                    'absolute -bottom-[11px] right-[6px] h-0.5 transition-colors md:right-[10px]',
                    isFirst ? 'left-0' : 'left-[6px] md:left-[10px]',
                    isActive
                      ? 'bg-foreground'
                      : 'bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600',
                  )}
                />
              </div>
            );
          })}
        </div>
        <div className="-mx-4 border-b border-gray-200 dark:border-border" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </div>
  );
}
