import { useAppAccess } from '@/hooks/use-app-access';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageLoader } from '@/components/page-loader';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';

/**
 * WeldHR module layout — same shell as WeldCRM / WeldCommerce / WeldStash:
 * breadcrumb root → `AppHeader` (top bar with breadcrumbs, command palette,
 * notifications) → `ModuleContent` (the content card; also mounts the object
 * panel and drawer hosts). Section navigation comes from the module sidebar
 * (`MODULE_CONFIGS.weldhr`).
 */
export default function WeldHrLayout({ children }: { children: React.ReactNode }) {
  const { isInstalled, isLoading } = useAppAccess('weldhr');
  const t = useTranslations();

  if (isLoading) return <PageLoader />;
  if (!isInstalled) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t('common.empty.appNotInstalled')}
      </div>
    );
  }

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t('weldhr.title'), href: '/weldhr' }]}>
      <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
        <AppHeader />
        <ModuleContent>{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
