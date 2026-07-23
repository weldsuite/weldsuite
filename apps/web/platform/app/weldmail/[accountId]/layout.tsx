
import { useEffect } from 'react';
import { useParams } from '@/lib/router';
import {
  useUserPreferences,
  useUpdateMailLastAccount,
} from '@/hooks/queries/use-settings-queries';

export default function MailAccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams<{ accountId: string }>();
  const { data: preferences } = useUserPreferences();
  const updateLastAccount = useUpdateMailLastAccount();

  // Remember the last account the user opened so /weldmail can land here next
  // time when no explicit default is pinned. Only writes when it actually
  // changed, to avoid a request on every navigation.
  const accountId = params.accountId;
  const storedLast = preferences?.uiPreferences?.mailLastAccountId;
  useEffect(() => {
    if (!accountId || !preferences) return;
    if (storedLast === accountId) return;
    updateLastAccount.mutate(accountId);
    // updateLastAccount is stable from react-query; intentionally not a dep.
  }, [accountId, storedLast, preferences]);

  if (!params.accountId) {
    return null;
  }

  return <>{children}</>;
}
