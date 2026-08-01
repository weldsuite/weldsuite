import { useAppAccess } from '@/hooks/use-app-access';
import { PageLoader } from '@/components/page-loader';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';
import { getTranslations } from '@/lib/i18n';

/**
 * WeldCommerce module layout, same shape as WeldCRM's `CrmLayoutClient`:
 * breadcrumb root → full-width `AppHeader` (the top nav) → `ModuleContent`.
 *
 * `ModuleContent` is not optional decoration: it lays out the content row and
 * mounts `<ObjectPanelHost />`, so without it the product / category / order
 * panels have nowhere to render. Section navigation comes from the global
 * module sidebar (`MODULE_CONFIGS.weldcommerce`), not from this file.
 */
export default function WeldCommerceLayout({ children }: { children: React.ReactNode }) {
  const t = getTranslations('commerce').module;
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
