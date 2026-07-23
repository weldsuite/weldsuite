
import { useEffect } from 'react';
import { useRouter } from '@/lib/router';
import { useMailAccounts } from '@/hooks/queries/use-mail-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function ComposeRedirectPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { data: accountsData, isLoading } = useMailAccounts();

  const accounts = accountsData?.data || [];
  const activeAccount = accounts.find((a: any) => a.isDefault) || accounts[0];

  useEffect(() => {
    if (!isLoading && activeAccount) {
      router.replace(`/weldmail/${activeAccount.id}/compose`);
    }
  }, [isLoading, activeAccount, router]);

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!activeAccount) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2">{t.mail.accounts.noEmailAccount}</h2>
          <p className="text-muted-foreground">
            {t.mail.accounts.noEmailAccountDescription}
          </p>
        </div>
      </div>
    );
  }

  return <PageLoader fullScreen={false} />;
}
