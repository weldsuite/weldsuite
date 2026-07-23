
import { useAppAccess } from '@/hooks/use-app-access';
import { HelpdeskLayoutClient } from './components/helpdesk-layout-client';
import { WidgetSettingsProvider } from './contexts/widget-settings-context';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function HelpdeskLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const { isInstalled, isLoading } = useAppAccess('welddesk');

  if (isLoading) return <PageLoader />;
  if (!isInstalled) return <div className="flex items-center justify-center h-screen text-muted-foreground">{t.helpdesk.helpdeskLayout.appNotInstalled}</div>;

  return (
    <WidgetSettingsProvider>
      <HelpdeskLayoutClient>
        {children}
      </HelpdeskLayoutClient>
    </WidgetSettingsProvider>
  );
}
