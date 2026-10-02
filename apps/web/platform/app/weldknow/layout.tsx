import { useAppAccess } from '@/hooks/use-app-access';
import { getTranslations } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';
import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';

/**
 * WeldKnow layout — same shell as WeldHR / WeldStash: breadcrumb root →
 * `AppHeader` → `ModuleContent`. The spaces/page tree lives in the shared
 * module sidebar (`useWeldknowSidebarItems`). Gated on both app installation
 * (useAppAccess) and the `knowledge:read` permission object.
 */
export default function WeldKnowLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { t } = useI18n();
  const tKnow = getTranslations('weldknow');
  const { isInstalled, isLoading } = useAppAccess('weldknow');
  const canRead = useCan('knowledge:read');

  if (isLoading) return <PageLoader />;

  if (!isInstalled) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t.common.empty.appNotInstalled}
      </div>
    );
  }

  if (!canRead) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {tKnow.emptyState.noAccessDescription}
      </div>
    );
  }

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: tKnow.breadcrumb.home, href: '/weldknow' }]}>
      <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
        <AppHeader />
        <ModuleContent className="overflow-y-auto">{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
