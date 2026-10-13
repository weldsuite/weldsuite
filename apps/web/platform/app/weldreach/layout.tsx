import { useAppAccess } from '@/hooks/use-app-access';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageLoader } from '@/components/page-loader';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';
import { ReachAccessBoundary } from './components/access-boundary';

/**
 * WeldReach module layout, same shell as WeldPass: breadcrumb root, `AppHeader`
 * (breadcrumbs, command palette, notifications), then `ModuleContent`. Section
 * navigation comes from the module sidebar (`MODULE_CONFIGS.weldreach`).
 *
 * WeldReach is on request only. Installing needs approved access, and the module
 * API refuses every call with 403 APP_ACCESS_REQUIRED once access is pending,
 * rejected, suspended or revoked, so the content sits behind
 * `ReachAccessBoundary`, which explains that state and otherwise shows usage
 * against the workspace's limits above the page.
 */
export default function WeldReachLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { isInstalled, isLoading } = useAppAccess('weldreach');
  const t = useTranslations();

  if (isLoading) return <PageLoader />;
  if (!isInstalled) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        {t('common.empty.appNotInstalled')}
      </div>
    );
  }

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t('reach.title'), href: '/weldreach' }]}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <AppHeader />
        <ModuleContent>
          <ReachAccessBoundary>{children}</ReachAccessBoundary>
        </ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
