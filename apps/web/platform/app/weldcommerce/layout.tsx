import { useAppAccess } from '@/hooks/use-app-access';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';
import { getTranslations } from '@/lib/i18n';

/**
 * WeldCommerce module layout (the rebuilt module, ADR COM-009), same shape as
 * WeldStash's: breadcrumb root → `AppHeader` → `ModuleContent`. Section
 * navigation comes from the module sidebar (`MODULE_CONFIGS.weldcommerce`).
 * Global never reaches it: the edition gate hides the module there.
 */
export default function WeldCommerceLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const t = getTranslations('commerce');
  const { isInstalled, isLoading } = useAppAccess('weldcommerce');

  if (isLoading) return <PageLoader />;
  if (!isInstalled) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t.notInstalled}
      </div>
    );
  }

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t.appTitle, href: '/weldcommerce' }]}>
      <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
        <AppHeader />
        <ModuleContent>{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
