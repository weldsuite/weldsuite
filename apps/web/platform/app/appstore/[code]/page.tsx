
import { useParams } from '@/lib/router';
import { useAvailableApps, useCanManageApps } from '@/hooks/queries/use-settings-queries';
import { AppDetailClient } from './app-detail-client';
import { AppStoreNoAccess } from '../appstore-no-access';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';

export default function AppDetailPage() {
  const t = getTranslations('navigation');
  const params = useParams();
  const code = params.code as string;

  const { data: apps, isLoading: appsLoading } = useAvailableApps();

  const { data: canManage, isLoading: canManageLoading } = useCanManageApps();

  const isLoading = appsLoading || canManageLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  // App Store is an install/uninstall surface — only owners/admins have access.
  if (!canManage) return <AppStoreNoAccess />;

  const app = (apps || []).find((a: any) => a.code === code);

  if (!app) {
    return <div className="flex items-center justify-center p-8 text-muted-foreground">{t.appstore.appNotFound}</div>;
  }

  return (
    <div className="w-full h-full bg-background flex flex-col">
      <AppDetailClient
        app={app}
        canManage={canManage ?? false}
        content={{
          overview: app.overview || null,
          features: app.features || [],
          version: app.version || '1.0.0',
          releasedAt: app.releasedAt ?? null,
        }}
      />
    </div>
  );
}
