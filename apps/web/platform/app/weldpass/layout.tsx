import { useAppAccess } from '@/hooks/use-app-access';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageLoader } from '@/components/page-loader';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';

/**
 * WeldPass module layout — same shell as WeldHR / WeldCRM / WeldStash:
 * breadcrumb root → `AppHeader` (top bar with breadcrumbs, command palette,
 * notifications) → `ModuleContent` (the content area). Section navigation
 * comes from the module sidebar (`MODULE_CONFIGS.weldpass`).
 */
export default function WeldPassLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { isInstalled, isLoading } = useAppAccess('weldpass');
  const t = useTranslations();

  if (isLoading) return <PageLoader />;
  if (!isInstalled) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        {t('common.empty.appNotInstalled')}
      </div>
    );
  }

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t('weldpass.title'), href: '/weldpass' }]}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <AppHeader />
        <ModuleContent>{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
