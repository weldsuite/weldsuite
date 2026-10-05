import { useMailAccounts } from '@/hooks/queries/use-mail-queries';
import { useUserPreferences } from '@/hooks/queries/use-settings-queries';
import { MailRedirect } from '../components/mail-redirect';
import { PageLoader } from '@/components/page-loader';
import { UNIFIED_ACCOUNT } from '../lib/mail-preferences';

/**
 * Snoozed mail lives in each mailbox (`/weldmail/{account}/snoozed`, or the unified
 * view). This path only forwards to it, using the same account the user last opened.
 */
export default function SnoozedPage() {
  const { data: accountsData, isLoading } = useMailAccounts();
  const { data: preferences, isLoading: prefsLoading } = useUserPreferences();

  if (isLoading || prefsLoading) return <PageLoader fullScreen={false} />;

  const accounts = accountsData?.data || [];
  if (accounts.length === 0) return <MailRedirect to="/weldmail/setup" />;

  const preferred =
    preferences?.uiPreferences?.mailLastAccountId ?? preferences?.uiPreferences?.mailDefaultAccountId;

  if (preferred === UNIFIED_ACCOUNT && accounts.length >= 2) {
    return <MailRedirect to="/weldmail/unified/snoozed" />;
  }

  const target =
    accounts.find((account) => account.id === preferred) ||
    accounts.find((account) => account.isDefault) ||
    accounts[0];

  return <MailRedirect to={`/weldmail/${target.id}/snoozed`} />;
}
