import { Lock } from 'lucide-react';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { getTranslations } from '@/lib/i18n';

/**
 * Shown when a user without the manage-apps permission (i.e. not an owner or
 * admin) navigates directly to /appstore. The rail button is hidden for them,
 * but the route is still reachable by URL, so we explain the lack of access
 * here instead of silently redirecting.
 */
export function AppStoreNoAccess() {
  const t = getTranslations('navigation');

  return (
    <div className="w-full h-full bg-background flex flex-col overflow-hidden">
      <BreadcrumbHeader segments={[{ label: t.appstore.title }]} />
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="flex flex-col items-center text-center max-w-md">
          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
            <Lock className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-2">
            {t.appstore.noAccessTitle}
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t.appstore.noAccessDescription}
          </p>
        </div>
      </div>
    </div>
  );
}
