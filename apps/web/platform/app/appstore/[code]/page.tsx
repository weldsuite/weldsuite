
import { useParams } from '@/lib/router';
import { useAvailableApps, useCanManageApps, type AvailableApp } from '@/hooks/queries/use-settings-queries';
import { AppDetailClient } from './app-detail-client';
import { AppStoreNoAccess } from '../appstore-no-access';
import { getConsolidatedCategory } from '../app-categories';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { getTranslations } from '@/lib/i18n';
import { normalizeAppCode } from '@weldsuite/permissions';

/**
 * The app a `/appstore/{code}` link names: its catalog code, or another name
 * of the same app (`/appstore/weldsocial` for the catalog's `social`).
 */
function findApp(apps: readonly AvailableApp[], code: string): AvailableApp | undefined {
  const exact = apps.find((a) => a.code === code);
  if (exact) return exact;
  const canonical = normalizeAppCode(code);
  return canonical ? apps.find((a) => normalizeAppCode(a.code) === canonical) : undefined;
}

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

  const app = findApp(apps || [], code);

  if (!app) {
    return <div className="flex items-center justify-center p-8 text-muted-foreground">{t.appstore.appNotFound}</div>;
  }

  const group = getConsolidatedCategory(app.category, app.code);
  const otherApps = (apps || []).filter((other: AvailableApp) => other.code !== app.code && getConsolidatedCategory(other.category, other.code) === group).slice(0, 6);

  return (
    <div className="w-full h-full bg-background flex flex-col">
      <AppDetailClient
        key={app.code}
        app={app}
        canManage={canManage ?? false}
        otherApps={otherApps}
        content={{
          overview: app.overview || null,
          features: app.features || [],
          howItWorks: app.howItWorks || [],
          version: app.version || '1.0.0',
          releasedAt: app.releasedAt ?? null,
        }}
      />
    </div>
  );
}
