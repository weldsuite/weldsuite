import { createFileRoute, redirect } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/page';
import { mailKeys } from '@/hooks/queries/use-mail-queries';
import { preferencesKey, type UserPreferences } from '@/hooks/queries/use-settings-queries';
import { resolveMailLandingPath } from '@/app/weldmail/lib/landing-redirect';
import type { ListResponse } from '@weldsuite/app-api-client';
import type { MailAccountRow } from '@weldsuite/app-api-client/domains/mail-accounts';

export const Route = createFileRoute('/weldmail/')({
  // When a previous open already left accounts + preferences in the query
  // cache (in memory, or restored from the persisted cache), redirect
  // straight to the landing mailbox instead of mounting `page.tsx` and
  // waiting for both to resolve again (docs/plans/weldmail-mailbox-storage.md
  // phase 1 item 7). Nothing cached yet: fall through to `page.tsx`, which
  // fetches both and redirects itself once they land.
  beforeLoad: ({ context }) => {
    const accounts = context.queryClient.getQueryData<ListResponse<MailAccountRow>>(
      mailKeys.accounts(),
    )?.data;
    const preferences = context.queryClient.getQueryData<UserPreferences>(preferencesKey)?.uiPreferences;
    const to = resolveMailLandingPath(accounts, preferences);
    if (to) throw redirect({ to });
  },
  component: PageComponent,
});
