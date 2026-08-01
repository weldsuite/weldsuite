import { useAppAccess } from '@/hooks/use-app-access';
import { PageLoader } from '@/components/page-loader';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';
import { getTranslations } from '@/lib/i18n';

/**
 * WeldStash module layout, same shape as WeldCRM's `CrmLayoutClient`:
 * breadcrumb root → full-width `AppHeader` (the top nav) → `ModuleContent`.
 *
 * `ModuleContent` also mounts `<ObjectPanelHost />`, which is what gives the
 * product / supplier / warehouse panels somewhere to render. Section
 * navigation comes from the global module sidebar (`MODULE_CONFIGS.weldstash`).
 */
export default function WeldStashLayout({ children }: { children: React.ReactNode }) {
  const t = getTranslations('common');
  const { isInstalled, isLoading } = useAppAccess('weldstash');

  if (isLoading) return <PageLoader />;
  if (!isInstalled) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t.weldstash.notInstalled}
      </div>
    );
  }

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t.weldstash.appTitle, href: '/weldstash' }]}>
      <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
        <AppHeader />
        <ModuleContent>{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
