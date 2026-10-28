
import { useMailAccounts } from '@/hooks/queries/use-mail-queries';
import { useUserPreferences } from '@/hooks/queries/use-settings-queries';
import { MailRedirect } from './components/mail-redirect';
import { PageLoader } from '@/components/page-loader';
import { UNIFIED_ACCOUNT } from './lib/mail-preferences';

// The fallback for a cold load: the route's `beforeLoad`
// (src/routes/weldmail/index.tsx, lib/landing-redirect.ts) redirects straight
// from the persisted query cache when it already has both accounts and
// preferences, so this component only mounts — and waits on both requests —
// when neither is cached yet.
export default function MailPage() {
  const { data: accountsData, isLoading } = useMailAccounts();
  // Personal, per-user landing preferences (default + last opened account).
  const { data: preferences, isLoading: prefsLoading } = useUserPreferences();

  if (isLoading || prefsLoading) return <PageLoader fullScreen={false} />;

  const emailAccounts = accountsData?.data || [];

  if (!emailAccounts || emailAccounts.length === 0) {
    return <MailRedirect to="/weldmail/setup" />;
  }

  // Resolve a stored preference (accountId or the "unified" sentinel) to a URL,
  // but only if it still points at something the user can actually open.
  const resolvePreference = (pref: string | null | undefined): string | null => {
    if (!pref) return null;
    if (pref === UNIFIED_ACCOUNT) {
      // Unified inbox only makes sense with 2+ accounts.
      return emailAccounts.length >= 2 ? '/weldmail/unified/inbox' : null;
    }
    return emailAccounts.some((acc) => acc.id === pref)
      ? `/weldmail/${pref}/inbox`
      : null;
  };

  // 1. Explicit user-pinned default wins.
  const defaultTo = resolvePreference(preferences?.uiPreferences?.mailDefaultAccountId);
  if (defaultTo) return <MailRedirect to={defaultTo} />;

  // 2. Otherwise fall back to the last account the user opened.
  const lastTo = resolvePreference(preferences?.uiPreferences?.mailLastAccountId);
  if (lastTo) return <MailRedirect to={lastTo} />;

  // 3. No preference yet: with 2+ accounts, default to the unified inbox.
  if (emailAccounts.length >= 2) {
    return <MailRedirect to="/weldmail/unified/inbox" />;
  }

  // 4. Single account: open the workspace default (or the only account).
  const defaultAccount = emailAccounts.find((acc) => acc.isDefault) || emailAccounts[0];

  return <MailRedirect to={`/weldmail/${defaultAccount.id}/inbox`} />;
}
