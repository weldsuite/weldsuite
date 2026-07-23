import { useAppAccess } from '@/hooks/use-app-access';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageLoader } from '@/components/page-loader';
import { WelddataLayoutClient } from './components/welddata-layout-client';

export default function WelddataLayout({ children }: { children: React.ReactNode }) {
  const { isInstalled, isLoading } = useAppAccess('welddata');
  const t = useTranslations();

  if (isLoading) return <PageLoader />;
  if (!isInstalled) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t('common.empty.appNotInstalled')}
      </div>
    );
  }

  return <WelddataLayoutClient>{children}</WelddataLayoutClient>;
}
