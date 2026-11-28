import { getLocale } from '@weldsuite/i18n';

/**
 * Labels of the `sso.*` admin audit actions, en + nl. Global's billing worker
 * recorded them; they stay in the activity log after Global moved into this
 * install. Like ./mollie-billing-copy.ts it lives with the console rather than
 * in the `admin` namespace of @weldsuite/i18n.
 */

const en = {
  activity: {
    'sso.grant': 'SSO price set',
    'sso.revoke': 'SSO revoked',
    'sso.connection.disable': 'SSO connection turned off',
  },
};

export type SsoCopy = typeof en;

const nl: SsoCopy = {
  activity: {
    'sso.grant': 'SSO-prijs ingesteld',
    'sso.revoke': 'SSO ingetrokken',
    'sso.connection.disable': 'SSO-verbinding uitgezet',
  },
};

/**
 * Same locale source as the rest of the console (`getLocale()`, the i18n
 * cookie); anything but `nl` reads English.
 */
function ssoCopy(): SsoCopy {
  return getLocale() === 'nl' ? nl : en;
}

/** The label of an `sso.*` admin audit action, or null for any other action. */
export function ssoActionLabel(action: string): string | null {
  const labels: Record<string, string> = ssoCopy().activity;
  return labels[action] ?? null;
}

export const ssoCopyByLocale = { en, nl } as const;
