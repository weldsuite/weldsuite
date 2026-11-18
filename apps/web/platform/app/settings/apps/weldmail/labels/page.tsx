
import { LabelsClient } from './labels-client';
import { useMailAccounts, useMailLabels } from '@/hooks/queries/use-mail-queries';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import type { Mail } from '@/lib/api/types/apps/mail.types';
import { isSystemLabel } from '@/app/weldmail/lib/label-config';

/**
 * WeldMail settings → Labels: the labels people made on their default mail
 * account, and their AI auto-labeling rules.
 */
export default function MailLabelsSettingsPage() {
  const { t } = useI18n();
  const { data: accountsData, isLoading: accountsLoading } = useMailAccounts();
  const accounts = accountsData?.data || [];
  const defaultAccount = accounts.find((a) => a.isDefault) || accounts[0];
  const accountId = defaultAccount?.id;

  const { data: labelsData, isLoading: labelsLoading } = useMailLabels(accountId, !!accountId);

  if (accountsLoading || labelsLoading) return <PageLoader fullScreen={false} />;

  if (!accountId) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t.mail.settingsLabels.labelManagementDescription}</p>
        <div className="text-center py-12 text-muted-foreground">
          {t.mail.settingsLabels.noEmailAccountFound}
        </div>
      </div>
    );
  }

  // Only the labels people made are managed here. The system folders (Inbox,
  // Sent, Drafts …) also have a row, but the server refuses to rename or
  // delete those, so offering the buttons only produced errors.
  const labels: Mail.Label[] = (labelsData?.data || [])
    .filter((l) => !l.isSystem && !isSystemLabel(l.name.toLowerCase()))
    .map((l) => ({
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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t.mail.settingsLabels.labelManagementDescription}</p>
      <LabelsClient initialLabels={labels} accountId={accountId} />
    </div>
  );
}
