
import { BillingSettingsSection } from '@/components/settings';
import { AccessDeniedEmptyState } from '@/components/access-denied-empty-state';
import { usePermissions } from '@weldsuite/permissions/react';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageLoader } from '@/components/page-loader';
import { ManagedBillingView } from '@/components/partner/managed-billing-view';
import { useManagedBilling } from '@/hooks/queries/use-partner-queries';

export default function BillingSettingsPage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canManageBilling = can('billing:manage');
  const { data: managed, isLoading: managedLoading } = useManagedBilling();

  // A partner-managed workspace has no plans to choose from: its partner bills it.
  if (managedLoading) return <PageLoader fullScreen={false} />;
  if (managed) return <ManagedBillingView info={managed} />;

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
