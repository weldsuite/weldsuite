
import { LabelsClient } from './labels-client';
import { useMailAccounts, useMailLabels } from '@/hooks/queries/use-mail-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import type { Mail } from '@/lib/api/types/apps/mail.types';

export default function LabelsPage() {
  const { t } = useI18n();
  const { data: accountsData, isLoading: accountsLoading } = useMailAccounts();
  const accounts = accountsData?.data || [];
  const defaultAccount = accounts.find((a) => a.isDefault) || accounts[0];
  const accountId = defaultAccount?.id;

  const { data: labelsData, isLoading: labelsLoading } = useMailLabels(accountId, !!accountId);

  if (accountsLoading || labelsLoading) return <PageLoader fullScreen={false} />;

  if (!accountId) {
    return (
      <div className="container max-w-4xl py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">{t.mail.settingsLabels.labelManagement}</h1>
          <p className="text-muted-foreground mt-2">
            {t.mail.settingsLabels.labelManagementDescription}
          </p>
        </div>
        <div className="text-center py-12 text-muted-foreground">
          {t.mail.settingsLabels.noEmailAccountFound}
        </div>
      </div>
    );
  }

  const labels: Mail.Label[] = (labelsData?.data || []).map((l) => ({
    id: l.id,
    name: l.name,
    color: l.color ?? undefined,
    count: l.messageCount || 0,
    aiEnabled: l.aiEnabled ?? undefined,
    aiKeywords: l.aiKeywords ?? undefined,
    aiDescription: l.aiDescription,
    aiConfidence: l.aiConfidence ?? undefined,
  }));

  return (
    <div className="container max-w-4xl py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">{t.mail.settingsLabels.labelManagement}</h1>
        <p className="text-muted-foreground mt-2">
          {t.mail.settingsLabels.labelManagementDescription}
        </p>
      </div>

      <LabelsClient initialLabels={labels} accountId={accountId} />
    </div>
  );
}
