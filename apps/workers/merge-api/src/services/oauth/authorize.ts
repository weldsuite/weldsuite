/**
 * Starting an OAuth round trip: validates what the caller asked for, stores
 * the state and builds the provider's consent URL. The redirect URI is always
 * `${APP_URL}/weldmerge/oauth/callback`, the one page registered on each OAuth
 * app.
 */

import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import { MERGE_OAUTH_CALLBACK_PATH, type MergeOauthPurpose } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import { trimTrailingSlashes } from '@weldsuite/merge-domain/providers/shared';
import type { Env } from '../../types';
import { ProviderNotConfiguredError } from '../providers/errors';
import { GITLAB_COM } from '../providers/gitlab/client';
import { oauthFor } from '../providers/registry';
import { createOAuthState } from './state';

export const redirectUriOf = (env: Pick<Env, 'APP_URL'>): string =>
  `${trimTrailingSlashes(env.APP_URL ?? '')}${MERGE_OAUTH_CALLBACK_PATH}`;

/** A same-app relative path (`/weldmerge/settings`); anything else (an absolute URL, `//host`) is dropped. */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || value.length > 500) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  return value;
}

/**
 * A GitLab host that is not gitlab.com is self-managed: the OAuth app belongs to
 * gitlab.com, so a self-managed host connects with a token. Normalizes a host
 * (no trailing slash, lower-case origin); gitlab.com is `null` (cloud).
 */
export function normalizeGitlabHost(host: string | null | undefined): string | null {
  if (!host?.trim()) return null;
  const url = new URL(host.trim());
  const normalized = trimTrailingSlashes(`${url.origin}${url.pathname}`);
  return normalized === GITLAB_COM ? null : normalized;
}

export interface AuthorizeInput {
  provider: MergeProvider;
  purpose: MergeOauthPurpose;
  workspaceId: string;
  userId: string;
  returnTo?: string | null;
  host?: string | null;
}

export type AuthorizeResult = { ok: true; url: string } | { ok: false; reason: 'self_managed_needs_token' };

export async function buildAuthorizeUrl(env: Env, input: AuthorizeInput): Promise<AuthorizeResult> {
  if (!env.APP_URL) throw new ProviderNotConfiguredError(input.provider);
  if (input.provider === 'gitlab' && normalizeGitlabHost(input.host) !== null) {
    return { ok: false, reason: 'self_managed_needs_token' };
  }
  const state = await createOAuthState(env.WORKSPACE_CACHE, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: input.provider,
    purpose: input.purpose,
    host: null,
    returnTo: safeReturnTo(input.returnTo),
  });
  const url = oauthFor(input.provider).authorizeUrl(env, { state, redirectUri: redirectUriOf(env), host: null });
  return { ok: true, url };
}
