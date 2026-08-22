import { useAppAccess } from '@/hooks/use-app-access';
import { PageLoader } from '@/components/page-loader';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';
import { getTranslations } from '@/lib/i18n';

export default function WeldAdsLayout({ children }: { children: React.ReactNode }) {
  const t = getTranslations('weldads').module;
  const { isInstalled, isLoading } = useAppAccess('weldads');

  if (isLoading) return <PageLoader />;
  if (!isInstalled) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t.notInstalled}
      </div>
    );
  }

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t.appTitle, href: '/weldads' }]}>
      <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
        <AppHeader />
        <ModuleContent>{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
