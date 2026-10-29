/**
 * Where `/weldmail` lands, computed from data that may already be sitting in
 * the persisted query cache (accounts + user preferences) — so the route's
 * `beforeLoad` (`src/routes/weldmail/index.tsx`) can redirect straight there
 * instead of waiting for both requests and redirecting from an effect
 * (`app/weldmail/page.tsx`, `components/mail-redirect.tsx`).
 *
 * Mirrors `page.tsx`'s resolution order exactly. Returns `null` when either
 * piece isn't cached yet (a cold load) — `page.tsx` then renders and redirects
 * the normal way once both of its own queries resolve.
 *
 * docs/plans/weldmail-mailbox-storage.md, phase 1 item 7.
 */

import { UNIFIED_ACCOUNT } from './mail-preferences';

export interface MailLandingAccount {
  id: string;
  isDefault?: boolean | null;
}

export interface MailLandingPreferences {
  mailDefaultAccountId?: string | null;
  mailLastAccountId?: string | null;
}

export function resolveMailLandingPath(
  accounts: MailLandingAccount[] | undefined,
  preferences: MailLandingPreferences | undefined,
): string | null {
  // Need both pieces: without preferences we can't tell a real "no
  // preference yet" apart from "not cached yet".
  if (!accounts || !preferences) return null;
  if (accounts.length === 0) return '/weldmail/setup';

  const resolvePreference = (pref: string | null | undefined): string | null => {
    if (!pref) return null;
    if (pref === UNIFIED_ACCOUNT) {
      return accounts.length >= 2 ? '/weldmail/unified/inbox' : null;
    }
    return accounts.some((acc) => acc.id === pref) ? `/weldmail/${pref}/inbox` : null;
  };

  const defaultTo = resolvePreference(preferences.mailDefaultAccountId);
  if (defaultTo) return defaultTo;

  const lastTo = resolvePreference(preferences.mailLastAccountId);
  if (lastTo) return lastTo;

  if (accounts.length >= 2) return '/weldmail/unified/inbox';

  const defaultAccount = accounts.find((acc) => acc.isDefault) ?? accounts[0];
  return `/weldmail/${defaultAccount.id}/inbox`;
}

/**
 * The single mailbox to warm on sidebar hover (`hooks/use-app-prefetch.ts`):
 * the same account `resolveMailLandingPath` would land on, except the unified
 * sentinel resolves to the workspace default/first account instead — there is
 * no single "unified mailbox" inbox to warm (the unified route's own prefetch,
 * `label-route-prefetch.ts`, covers it without an accountId).
 */
export function pickWarmMailAccountId(
  accounts: MailLandingAccount[] | undefined,
  preferences: MailLandingPreferences | undefined,
): string | undefined {
  if (!accounts || accounts.length === 0) return undefined;
  const validAccountId = (id: string | null | undefined): string | undefined =>
    id && id !== UNIFIED_ACCOUNT && accounts.some((acc) => acc.id === id) ? id : undefined;
  return (
    validAccountId(preferences?.mailDefaultAccountId) ??
    validAccountId(preferences?.mailLastAccountId) ??
    accounts.find((acc) => acc.isDefault)?.id ??
    accounts[0]?.id
  );
}
