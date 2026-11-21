import { useEffect } from 'react';
import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { useAppAccess } from '@/hooks/use-app-access';
import { isFeatureAvailable } from '@/lib/edition';
import { useI18n } from '@/lib/i18n/provider';
import { usePathname, useRouter } from '@/lib/router';
import { ChartAnnotationsProvider } from './components/charts/annotations-context';
import { UsageBanner } from './components/usage-banner';

const PROJECTS_PATH = '/weldpanel/projects';

/** The Projects pages (list, a project's settings and install) are all a Kubernetes edition serves. */
export function isProjectsPath(pathname: string): boolean {
  return pathname === PROJECTS_PATH || pathname.startsWith(`${PROJECTS_PATH}/`);
}

/**
 * WeldPanel layout: breadcrumb root → `AppHeader` → usage banner → `ModuleContent`,
 * with the project picked in the sidebar (`WeldPanelProjectSwitcher`),
 * gated on the app being installed and the `panel_projects:read` permission.
 * Where analytics aren't available (the Kubernetes editions), every page but
 * the projects redirects to the projects list.
 */
export default function WeldPanelLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { t } = useI18n();
  const { isInstalled, isLoading } = useAppAccess('weldpanel');
  const canRead = useCan('panel_projects:read');
  const pathname = usePathname();
  const router = useRouter();
  const analytics = isFeatureAvailable('panel-analytics');
  const redirect = !analytics && !isProjectsPath(pathname);

  useEffect(() => {
    if (redirect) router.replace(PROJECTS_PATH);
  }, [redirect, router]);

  if (isLoading || redirect) return <PageLoader />;

  if (!isInstalled) {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">{t.common.empty.appNotInstalled}</div>;
  }

  if (!canRead) {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">{t.weldpanel.noAccess}</div>;
  }

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t.weldpanel.breadcrumb.home, href: '/weldpanel' }]}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <AppHeader />
        {analytics && <UsageBanner />}
        {/* Time charts on every page show the project's annotations (and the open report's own). */}
        <ModuleContent className="min-h-0 overflow-y-auto">{analytics ? <ChartAnnotationsProvider enabled>{children}</ChartAnnotationsProvider> : children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
