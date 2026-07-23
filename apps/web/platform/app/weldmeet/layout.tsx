import { useAppAccess } from '@/hooks/use-app-access';
import { WeldMeetLayoutClient } from './components/weldmeet-layout-client';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';

export default function WeldMeetLayout({ children }: { children: React.ReactNode }) {
  const t = getTranslations('weldmeet');
  const { isInstalled, isLoading } = useAppAccess('weldmeet');

  if (isLoading) return <PageLoader />;
  if (!isInstalled)
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t.layout.appNotInstalled}
      </div>
    );

  return (
    <WeldMeetLayoutClient>
      {children}
    </WeldMeetLayoutClient>
  );
}
