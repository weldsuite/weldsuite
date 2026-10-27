import * as React from 'react';
import { usePathname } from '@/lib/router';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { ModuleContent } from '@/components/layout/module-content';
import { useI18n } from '@/lib/i18n/provider';
import { buildBreadcrumbSegments } from './breadcrumbs';

const FULL_WIDTH_CLASS = 'h-full';
const PAGE_PADDING_CLASS = 'px-4 md:px-6 pt-4 md:pt-[72px] pb-8';

// Pick the content wrapper classes for the current settings page.
function getContentWrapperClassName(pathname: string): string {
  // Member detail, integrations listing + detail, new number page, an entity's
  // invoice templates + their designer: full width
  if (
    /^\/settings\/team\/[^/]+$/.test(pathname) ||
    pathname === '/settings/integrations' ||
    /^\/settings\/integrations\/[^/]+$/.test(pathname) ||
    pathname === '/settings/apps/phone-numbers/new-number' ||
    /^\/settings\/entities\/[^/]+\/invoice-templates(\/[^/]+)?$/.test(pathname)
  ) {
    return FULL_WIDTH_CLASS;
  }
  // Plans page - allow internal width control
  if (pathname === '/settings/plans') return PAGE_PADDING_CLASS;
  // Every other settings page: one fixed column width. `w-full` matters, the
  // wrapper is a flex item and would otherwise shrink to its content;
  // `min-w-0` keeps a wide child (table, chart, preview) from pushing it past
  // the column, so the page clips or scrolls inside its own boxes instead.
  return `${PAGE_PADDING_CLASS} w-full min-w-0 max-w-[715px] mx-auto`;
}

/**
 * Width of the open member drawer (`TeamMemberDetailsPanel`), which announces
 * itself with a `member-detail-panel` `{ isOpen, width }` event. The drawer is
 * fixed-position, so without this the page would sit underneath it instead of
 * shrinking beside it the way it does for an in-flow object panel.
 */
function useMemberPanelWidth(): number {
  const [width, setWidth] = React.useState(0);
  // Layout effect: the drawer announces itself from a passive effect, and a
  // drawer that opens in the same commit as this layout (a `?member=` deep
  // link with cached members) would otherwise fire before we listen.
  React.useLayoutEffect(() => {
    const handler = (e: Event) => {
      const { isOpen, width: panelWidth } = (e as CustomEvent<{ isOpen: boolean; width: number }>).detail;
      setWidth(isOpen ? panelWidth : 0);
    };
    window.addEventListener('member-detail-panel', handler);
    return () => window.removeEventListener('member-detail-panel', handler);
  }, []);
  return width;
}

/**
 * Settings layout: breadcrumb header + content. The settings menu (with its
 * back button) is the unified module sidebar that PlatformShell renders for
 * every module, see `useSettingsSidebarItems`.
 */
export function SettingsLayoutClient({ children }: Readonly<{ children: React.ReactNode }>) {
  const { t } = useI18n();
  const ts = t.settings;
  const pathname = usePathname();

  const segments = buildBreadcrumbSegments(pathname, ts.title, ts.menu);
  const memberPanelWidth = useMemberPanelWidth();

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
      <BreadcrumbHeader
        segments={segments}
        showBackButton={false}
        moduleKey="settings"
      />
      <ModuleContent
        className="overflow-y-auto"
        aside={
          // Keeps the drawer's column free. Below md the drawer covers the
          // whole screen, so there is nothing to make room for.
          memberPanelWidth > 0 ? (
            <div aria-hidden className="hidden md:block shrink-0" style={{ width: memberPanelWidth }} />
          ) : undefined
        }
      >
        <div className={getContentWrapperClassName(pathname)}>{children}</div>
      </ModuleContent>
    </div>
  );
}
