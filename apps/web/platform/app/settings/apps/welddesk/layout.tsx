import { useAppAccess } from '@/hooks/use-app-access';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

/**
 * Settings → Apps → WeldDesk. The WeldDesk settings pages live here, inside
 * workspace Settings, rather than in the WeldDesk app. Some of them still set
 * WeldDesk breadcrumbs; the provider keeps that working, while the settings
 * header builds its own trail from the path.
 */
export default function WeldDeskSettingsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { t } = useI18n();
  const { isInstalled, isLoading } = useAppAccess('welddesk');

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (!isInstalled) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        {t.helpdesk.helpdeskLayout.appNotInstalled}
      </div>
    );
  }

  return <BreadcrumbProvider>{children}</BreadcrumbProvider>;
}
