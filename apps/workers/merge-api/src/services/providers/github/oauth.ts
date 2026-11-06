/**
 * GitHub's user authorization (user-to-server OAuth of the WeldSuite GitHub
 * App): members link their own GitHub account so reviews and merges run as them.
 * The workspace connection is the App installation, not an OAuth token, so this
 * is the member side only. The App's permissions decide what the token can do.
 *
 *   GET  https://github.com/login/oauth/authorize?client_id&redirect_uri&state
 *   POST https://github.com/login/oauth/access_token   (authorization_code, refresh_token)
 *   GET  https://api.github.com/user
 */

import { ProviderNotConfiguredError } from '../errors';
import { bearer, credentialsFromToken, requestJson } from '../provider-http';
import { ProviderApiError, type OAuthProvider } from '../types';
import type { Env } from '../../../types';

const TOKEN_URL = 'https://github.com/login/oauth/access_token';

function credentialsOf(env: Env): { clientId: string; clientSecret: string } {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) throw new ProviderNotConfiguredError('github');
  return { clientId: env.GITHUB_APP_CLIENT_ID, clientSecret: env.GITHUB_APP_CLIENT_SECRET };
}

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** GitHub answers a failed code exchange with 200 and an `error` field. */
function checked(body: TokenBody | null) {
  if (body?.error) throw new ProviderApiError('github', 400, body.error_description ?? body.error);
  return credentialsFromToken(body ?? {}, 'github');
}

export const githubOAuth: OAuthProvider = {
  authorizeUrl(env, input) {
    const { clientId } = credentialsOf(env);
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: input.redirectUri, state: input.state });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  },

  async exchangeCode(env, input) {
    const { clientId, clientSecret } = credentialsOf(env);
    return checked(
      await requestJson<TokenBody>('github', {
        method: 'POST',
        url: TOKEN_URL,
        json: { client_id: clientId, client_secret: clientSecret, code: input.code, redirect_uri: input.redirectUri },
      }),
    );
  },

  async refresh(env, input) {
    const { clientId, clientSecret } = credentialsOf(env);
    return checked(
      await requestJson<TokenBody>('github', {
        method: 'POST',
        url: TOKEN_URL,
        json: { client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: input.refreshToken },
      }),
    );
  },

  async currentUser(_env, input) {
    const user = await requestJson<{ id: number; login: string; name?: string | null; avatar_url?: string | null }>('github', {
      method: 'GET',
      url: 'https://api.github.com/user',
      headers: { ...bearer(input.accessToken), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!user) throw new Error('GitHub answered /user with an empty body');
    return {
      externalId: String(user.id),
      login: user.login.toLowerCase(),
      displayName: user.name ?? null,
      avatarUrl: user.avatar_url ?? null,
    };
  },
};
