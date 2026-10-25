import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { useAppAccess } from '@/hooks/use-app-access';
import { useI18n } from '@/lib/i18n/provider';

/**
 * WeldDocs layout: breadcrumb root → `AppHeader` → `ModuleContent`, gated on
 * the app being installed and the `docs:read` permission.
 */
export default function WeldDocsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { t } = useI18n();
  const { isInstalled, isLoading } = useAppAccess('welddocs');
  const canRead = useCan('docs:read');

  if (isLoading) return <PageLoader />;

  if (!isInstalled) {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">{t.common.empty.appNotInstalled}</div>;
  }

  if (!canRead) {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">{t.welddocs.noAccess}</div>;
  }

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t.welddocs.breadcrumb.home, href: '/welddocs' }]}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <AppHeader />
        <ModuleContent className="min-h-0 overflow-y-auto">{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
