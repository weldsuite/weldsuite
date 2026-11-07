/**
 * GitLab OAuth (the WeldSuite application on gitlab.com; `GITLAB_OAUTH_CLIENT_ID`
 * / `_SECRET`). Scope `api` covers reading, hooks, review and merge. Self-managed
 * hosts connect with an access token instead (the OAuth app belongs to
 * gitlab.com), so `host` here is only ever gitlab.com.
 *
 *   GET  https://gitlab.com/oauth/authorize?client_id&redirect_uri&response_type=code&scope=api&state
 *   POST https://gitlab.com/oauth/token        (authorization_code, refresh_token)
 *   GET  https://gitlab.com/api/v4/user
 */

import { ProviderNotConfiguredError } from '../errors';
import { bearer, credentialsFromToken, requestJson } from '../provider-http';
import type { OAuthProvider, OAuthUser } from '../types';
import type { Env } from '../../../types';
import { gitlabBase } from './client';

function credentialsOf(env: Env): { clientId: string; clientSecret: string } {
  if (!env.GITLAB_OAUTH_CLIENT_ID || !env.GITLAB_OAUTH_CLIENT_SECRET) throw new ProviderNotConfiguredError('gitlab');
  return { clientId: env.GITLAB_OAUTH_CLIENT_ID, clientSecret: env.GITLAB_OAUTH_CLIENT_SECRET };
}

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export interface GitlabUserBody {
  id: number;
  username: string;
  name?: string | null;
  avatar_url?: string | null;
}

export function gitlabOAuthUser(body: GitlabUserBody): OAuthUser {
  return {
    externalId: String(body.id),
    login: body.username.toLowerCase(),
    displayName: body.name ?? null,
    avatarUrl: body.avatar_url ?? null,
  };
}

/** `GET {host}/api/v4/user` with a token: validates it and says whose it is (also used for typed self-managed tokens). */
export async function gitlabCurrentUser(host: string | null | undefined, accessToken: string): Promise<OAuthUser> {
  const body = await requestJson<GitlabUserBody>('gitlab', {
    method: 'GET',
    url: `${gitlabBase(host)}/api/v4/user`,
    headers: bearer(accessToken),
  });
  if (!body) throw new Error('GitLab answered /user with an empty body');
  return gitlabOAuthUser(body);
}

export const gitlabOAuth: OAuthProvider = {
  authorizeUrl(env, input) {
    const { clientId } = credentialsOf(env);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: 'api',
      state: input.state,
    });
    return `${gitlabBase(input.host)}/oauth/authorize?${params.toString()}`;
  },

  async exchangeCode(env, input) {
    const { clientId, clientSecret } = credentialsOf(env);
    const body = await requestJson<TokenBody>('gitlab', {
      method: 'POST',
      url: `${gitlabBase(input.host)}/oauth/token`,
      form: {
        client_id: clientId,
        client_secret: clientSecret,
        code: input.code,
        grant_type: 'authorization_code',
        redirect_uri: input.redirectUri,
      },
    });
    return credentialsFromToken(body ?? {}, 'gitlab');
  },

  async refresh(env, input) {
    const { clientId, clientSecret } = credentialsOf(env);
    const body = await requestJson<TokenBody>('gitlab', {
      method: 'POST',
      url: `${gitlabBase(input.host)}/oauth/token`,
      form: {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: input.refreshToken,
        grant_type: 'refresh_token',
        redirect_uri: `${env.APP_URL ?? ''}/weldmerge/oauth/callback`,
      },
    });
    return credentialsFromToken(body ?? {}, 'gitlab');
  },

  currentUser(_env, input) {
    return gitlabCurrentUser(input.host, input.accessToken);
  },
};
