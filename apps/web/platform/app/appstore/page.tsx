
import { usePermissions } from '@weldsuite/permissions/react';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { ModuleContent } from '@/components/layout/module-content';
import { useAvailableApps, useAppCategories, useCanManageApps } from '@/hooks/queries/use-settings-queries';
import { AppStoreClient } from './app-store-client';
import { AppStoreNoAccess } from './appstore-no-access';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { getTranslations } from '@/lib/i18n';

export default function AppStorePage() {
  const t = getTranslations('navigation');
  const { can, isOwner } = usePermissions();
  const { data: apps, isLoading: appsLoading } = useAvailableApps();

  const { data: categories, isLoading: categoriesLoading } = useAppCategories();

  const { data: canManage, isLoading: canManageLoading } = useCanManageApps();

  const isLoading = appsLoading || categoriesLoading || canManageLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  // App Store is an install/uninstall surface — only owners/admins have access.
  if (!canManage) return <AppStoreNoAccess />;

  const canDevelopWeldApps = isOwner || can('weldapps:develop');

  return (
    <div className="w-full h-full bg-background flex flex-col overflow-hidden">
      <BreadcrumbHeader
        segments={[
          { label: t.appstore.title }
        ]}
      />
      <ModuleContent className="overflow-auto">
        <AppStoreClient initialApps={apps || []} categories={categories || []} canManage={canManage ?? false} canDevelop={canDevelopWeldApps} />
      </ModuleContent>
    </div>
  );
}
