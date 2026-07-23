
import { BillingSettingsSection } from '@/components/settings';
import { AccessDeniedEmptyState } from '@/components/access-denied-empty-state';
import { usePermissions } from '@weldsuite/permissions/react';
import { useTranslations } from '@weldsuite/i18n/client';

export default function BillingSettingsPage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canManageBilling = can('billing:manage');

  if (!canManageBilling) {
    return (
      <AccessDeniedEmptyState
        description={t('sweep.settings.plansPage.accessDeniedDescription')}
        permission="billing:manage"
        pageLabel={t('sweep.settings.plansPage.pageLabel')}
      />
    );
  }

  return <BillingSettingsSection />;
}
