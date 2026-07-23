
import { useAppAccess } from '@/hooks/use-app-access';
import { CrmLayoutClient } from './components/crm-layout-client';
import { PageLoader } from '@/components/page-loader';
import { useTranslations } from '@weldsuite/i18n/client';

export default function CrmLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isInstalled, isLoading } = useAppAccess('weldcrm');
  const t = useTranslations();

  if (isLoading) return <PageLoader />;
  if (!isInstalled) return <div className="flex items-center justify-center h-screen text-muted-foreground">{t('common.empty.appNotInstalled')}</div>;

  return (
    <CrmLayoutClient>
      {children}
    </CrmLayoutClient>
  );
}
