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
  // Member detail, integrations listing + detail, new number page: full width
  if (
    /^\/settings\/team\/[^/]+$/.test(pathname) ||
    pathname === '/settings/integrations' ||
    /^\/settings\/integrations\/[^/]+$/.test(pathname) ||
    pathname === '/settings/apps/phone-numbers/new-number'
  ) {
    return FULL_WIDTH_CLASS;
  }
  // Plans page - allow internal width control
  if (pathname === '/settings/plans') return PAGE_PADDING_CLASS;
  // Activity log and WeldHR — slightly wider so the tables fit without scroll
  if (pathname === '/settings/activity' || pathname === '/settings/apps/weldhr') {
    return `${PAGE_PADDING_CLASS} max-w-6xl mx-auto`;
  }
  // Regular settings pages - constrained width
  return `${PAGE_PADDING_CLASS} max-w-4xl mx-auto`;
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

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
      <BreadcrumbHeader
        segments={segments}
        showBackButton={false}
        moduleKey="settings"
      />
      <ModuleContent className="overflow-y-auto">
        <div className={getContentWrapperClassName(pathname)}>{children}</div>
      </ModuleContent>
    </div>
  );
}
