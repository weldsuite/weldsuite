import { useTranslations } from '@weldsuite/i18n/client';
import { ReactNode, useMemo } from 'react';
import { BreadcrumbProvider, useBreadcrumbs, type BreadcrumbSegment } from '@/contexts/breadcrumb-context';
import { usePathname } from '@/lib/router';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';

interface CrmLayoutClientProps {
  children: ReactNode;
}

type Translate = (path: string) => string;

/**
 * Which CRM section a path belongs to, as the translation key of its label.
 * Null for paths whose page sets its own breadcrumb (Sequences) or that are
 * unknown, which keep the plain "CRM" crumb.
 */
export function getCrmSectionLabelKey(pathname: string): string | null {
  if (pathname === '/weldcrm' || pathname === '/weldcrm/') return 'navigation.moduleSidebar.weldcrm.myTasks';
  if (pathname.startsWith('/weldcrm/sequences')) return null;
  if (pathname.startsWith('/weldcrm/companies/lists') || pathname.startsWith('/weldcrm/lists')) return 'crm.sidebar.lists';
  if (pathname.startsWith('/weldcrm/companies')) return 'navigation.moduleSidebar.weldcrm.companies';
  if (pathname.startsWith('/weldcrm/people')) return 'navigation.moduleSidebar.weldcrm.people';
  if (pathname.startsWith('/weldcrm/notes')) return 'navigation.moduleSidebar.weldcrm.notes';
  if (pathname.startsWith('/weldcrm/pipeline')) return 'crm.breadcrumb.deals';
  return null;
}

export function getCrmBreadcrumbs(pathname: string, t: Translate): BreadcrumbSegment[] {
  const root: BreadcrumbSegment = { label: t('crm.breadcrumb.crm'), href: '/weldcrm' };
  const labelKey = getCrmSectionLabelKey(pathname);
  return labelKey ? [root, { label: t(labelKey) }] : [root];
}

/**
 * Shows the current section after "CRM" (CRM > Companies, ...). Pages that
 * set their own breadcrumbs (Sequences) opt out via a null section key, so
 * their crumbs are not overwritten by this one.
 */
function CrmSectionBreadcrumbs() {
  const t = useTranslations();
  const pathname = usePathname();
  const segments = useMemo(() => getCrmBreadcrumbs(pathname ?? '', t), [pathname, t]);
  useBreadcrumbs(segments, { enabled: getCrmSectionLabelKey(pathname ?? '') !== null });
  return null;
}

export function CrmLayoutClient({ children }: Readonly<CrmLayoutClientProps>) {
  const t = useTranslations();

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t('crm.breadcrumb.crm'), href: '/weldcrm' }]}>
      <CrmSectionBreadcrumbs />
      <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
        {/* Full-width header. Drawer state lives in shared hooks (the header's
            buttons toggle it, DrawerHost renders it), so no callbacks needed. */}
        <AppHeader />
        {/* Content row: module content + object panel(s) + drawers, all flex
            siblings with a uniform gap (see ModuleContent). */}
        <ModuleContent>{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
