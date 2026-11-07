import { useCanAny } from '@weldsuite/permissions/react';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { useAppAccess } from '@/hooks/use-app-access';
import { useI18n } from '@/lib/i18n/provider';

/** Any of these opens the module; each page and action checks its own permission. */
export const WELDMERGE_READ_PERMISSIONS = ['merge_pull_requests:read', 'merge_issues:read', 'merge_connections:read'];

/**
 * WeldMerge layout: breadcrumb root, `AppHeader`, `ModuleContent`; gated on the
 * app being installed and on being able to read at least one part of it.
 */
export default function WeldMergeLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { t } = useI18n();
  const { isInstalled, isLoading } = useAppAccess('weldmerge');
  const canRead = useCanAny(WELDMERGE_READ_PERMISSIONS);

  if (isLoading) return <PageLoader />;

  if (!isInstalled) {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">{t.common.empty.appNotInstalled}</div>;
  }

  if (!canRead) {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">{t.weldmerge.noAccess}</div>;
  }

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t.weldmerge.breadcrumb.home, href: '/weldmerge' }]}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <AppHeader />
        <ModuleContent className="min-h-0 overflow-y-auto">{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
