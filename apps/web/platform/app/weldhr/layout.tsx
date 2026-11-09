import { useAppAccess } from '@/hooks/use-app-access';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';
import { EntityPermissionScope } from '@/components/legal-entity/entity-permission-scope';
import { useCurrentLegalEntity } from '@/hooks/use-current-legal-entity';

/**
 * WeldHR module layout — same shell as WeldCRM / WeldCommerce / WeldStash:
 * breadcrumb root → `AppHeader` (top bar with breadcrumbs, command palette,
 * notifications) → `ModuleContent` (the content card; also mounts the object
 * panel and drawer hosts). Section navigation comes from the module sidebar
 * (`MODULE_CONFIGS.weldhr`).
 *
 * HR works inside the selected legal entity (the sidebar switcher): permission
 * checks below use the member's role in it, and pages wait for the entity list
 * so their first requests already carry the entity.
 */
export default function WeldHrLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { isInstalled, isLoading } = useAppAccess('weldhr');
  const t = useTranslations();
  const { entityId, isLoading: entitiesLoading } = useCurrentLegalEntity({ app: 'weldhr', enabled: isInstalled });

  if (isLoading || (isInstalled && entitiesLoading)) return <PageLoader />;
  if (!isInstalled) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t('common.empty.appNotInstalled')}
      </div>
    );
  }

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t('weldhr.title'), href: '/weldhr' }]}>
      <EntityPermissionScope entityId={entityId}>
        <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
          <AppHeader />
          <ModuleContent>{children}</ModuleContent>
        </div>
      </EntityPermissionScope>
    </BreadcrumbProvider>
  );
}
