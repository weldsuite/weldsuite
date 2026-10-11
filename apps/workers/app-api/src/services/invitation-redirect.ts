/**
 * Where the "Accept invitation" link in a workspace invite lands.
 *
 * Clerk's invitation link (`invitation.url`) goes to Clerk first, then to the
 * `redirect_url` we pass when creating the invitation, with `__clerk_ticket`
 * and `__clerk_status` appended. Without one, the platform's /invite page
 * never learns which workspace the link is for, so a member who is already
 * signed in to another workspace stayed where they were (TASK-1074). The
 * `org_id` lets that page accept the right invitation and switch to it.
 */

import type { Env } from '../types';

const PLATFORM_URLS: Record<string, string> = {
  development: 'http://localhost:3000',
  test: 'https://app-test.weldsuite.org',
  production: 'https://app.weldsuite.org',
};

/** Platform SPA base URL: `PUBLIC_APP_URL` when set, else per environment. */
export function getPlatformUrl(env: Pick<Env, 'ENVIRONMENT' | 'PUBLIC_APP_URL'>): string {
  const configured = env.PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return PLATFORM_URLS[env.ENVIRONMENT] ?? PLATFORM_URLS.development;
}

/** The `redirect_url` for a Clerk organization invitation into `orgId`. */
export function invitationRedirectUrl(
  env: Pick<Env, 'ENVIRONMENT' | 'PUBLIC_APP_URL'>,
  orgId: string,
): string {
  const url = new URL('/invite', getPlatformUrl(env));
  url.searchParams.set('org_id', orgId);
  return url.toString();
}
