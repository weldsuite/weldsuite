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

/** Per-product scope sets, composed into each provider's `auth.scopes`. */
export const GOOGLE_SCOPES = {
  userinfo: ['openid', 'email', 'profile'],
  sheets: ['https://www.googleapis.com/auth/spreadsheets'],
  gmail: [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
  ],
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
} as const;

/** Build a Google `OAuthConfig` for a product by merging its scopes with the
 *  base userinfo scopes (needed by the connection test ping). */
export function googleAuth(scopes: readonly string[]): OAuthConfig {
  return {
    ...GOOGLE_AUTH_BASE,
    scopes: [...new Set([...GOOGLE_SCOPES.userinfo, ...scopes])],
  };
}
