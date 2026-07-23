import { useAppAccess } from '@/hooks/use-app-access';
import { AccountingLayoutClient } from './components/accounting-layout-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function AccountingLayout({ children }: { children: React.ReactNode }) {
  const { isInstalled, isLoading } = useAppAccess('weldbooks');
  const { t } = useI18n();
  if (isLoading) return <PageLoader />;
  if (!isInstalled)
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t.accounting.layout.appNotInstalled}
      </div>
    );
  return (
    <AccountingLayoutClient>{children}</AccountingLayoutClient>
  );
}
