import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { useAppAccess } from '@/hooks/use-app-access';
import { useI18n } from '@/lib/i18n/provider';

/**
 * WeldSheets layout: breadcrumb root → `AppHeader` → `ModuleContent`, gated on
 * the app being installed and the `sheets:read` permission.
 */
export default function WeldSheetsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { t } = useI18n();
  const { isInstalled, isLoading } = useAppAccess('weldsheets');
  const canRead = useCan('sheets:read');

  if (isLoading) return <PageLoader />;

  if (!isInstalled) {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">{t.common.empty.appNotInstalled}</div>;
  }

  if (!canRead) {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">{t.weldsheets.noAccess}</div>;
  }

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t.weldsheets.breadcrumb.home, href: '/weldsheets' }]}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <AppHeader />
        <ModuleContent className="min-h-0 overflow-y-auto">{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
