import { useAppAccess } from '@/hooks/use-app-access';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageLoader } from '@/components/page-loader';

export default function WeldPassLayout({ children }: { children: React.ReactNode }) {
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

  return <div className="flex h-full flex-col">{children}</div>;
}
