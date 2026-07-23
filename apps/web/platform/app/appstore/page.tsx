
import { Link } from '@/lib/router';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { ModuleContent } from '@/components/layout/module-content';
import { useAvailableApps, useAppCategories, useCanManageApps } from '@/hooks/queries/use-settings-queries';
import { AppStoreClient } from './app-store-client';
import { AppStoreNoAccess } from './appstore-no-access';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';

export default function AppStorePage() {
  const t = getTranslations('navigation');
  const { t: allT } = useI18n();
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
        actions={
          canDevelopWeldApps ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/apps/manage">{allT.weldapps.breadcrumb.myApps}</Link>
            </Button>
          ) : undefined
        }
      />
      <ModuleContent className="overflow-auto">
        <AppStoreClient initialApps={apps || []} categories={categories || []} canManage={canManage ?? false} />
      </ModuleContent>
    </div>
  );
}
