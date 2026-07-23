import { useAppAccess } from '@/hooks/use-app-access';
import { DriveLayoutClient } from './components/drive-layout-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function DriveLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isInstalled, isLoading } = useAppAccess('welddrive');
  const { t } = useI18n();

  if (isLoading) return <PageLoader />;
  if (!isInstalled) return <div className="flex items-center justify-center h-screen text-muted-foreground">{t.welddrive.layout.appNotInstalled}</div>;

  return (
    <DriveLayoutClient>
      {children}
    </DriveLayoutClient>
  );
}
