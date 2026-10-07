/**
 * Shared Google OAuth config.
 *
 * Reused by every Google-Workspace integration (Sheets today; Gmail and
 * Calendar next) so the Google OAuth client + token-refresh path is built once.
 * Each product composes its own scope set from `GOOGLE_SCOPES`.
 */

import type { OAuthConfig } from '../types';

/** Authorize/token endpoints + the offline-access params required to receive a
 *  refresh token (Google only returns one with `access_type=offline` + a
 *  `prompt=consent` re-consent). */
export const GOOGLE_AUTH_BASE: Omit<OAuthConfig, 'scopes'> = {
  kind: 'oauth2',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientIdEnv: 'GOOGLE_CLIENT_ID',
  clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
  authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
};

/**
 * Per-product scope sets, composed into each provider's `auth.scopes`.
 *
 * `gmail` is deliberately `gmail.send` only — NOT `gmail.readonly` — because
 * only `gmail.send_email` is unlocked this phase. `gmail.readonly` is a Google
 * "restricted" scope (full mailbox read access): requesting it would put the
 * OAuth consent screen through Google's CASA security assessment, not just
 * standard verification. `gmail.send` is "sensitive" (standard verification
 * only). Add `gmail.readonly` back — and re-run verification — only when the
 * `gmail.new_email` poll trigger is unlocked (docs/plans/weldconnect.md).
 */
export const GOOGLE_SCOPES = {
  userinfo: ['openid', 'email', 'profile'],
  sheets: ['https://www.googleapis.com/auth/spreadsheets'],
  gmail: ['https://www.googleapis.com/auth/gmail.send'],
  // calendar.events: create/edit events. calendar.calendarlist.readonly: list
  // which calendars the account has (the create_event step's calendar
  // picker, calendarList.list) — calendar.events alone doesn't cover that
  // call. Both are "non-sensitive"/"sensitive" tier, never "restricted".
  calendar: [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  ],
} as const;

/** Build a Google `OAuthConfig` for a product by merging its scopes with the
 *  base userinfo scopes (needed by the connection test ping). */
export function googleAuth(scopes: readonly string[]): OAuthConfig {
  return {
    ...GOOGLE_AUTH_BASE,
    scopes: [...new Set([...GOOGLE_SCOPES.userinfo, ...scopes])],
  };
}
