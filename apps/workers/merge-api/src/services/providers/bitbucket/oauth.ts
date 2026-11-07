/**
 * Bitbucket Cloud OAuth (the OAuth consumer; `BITBUCKET_OAUTH_CLIENT_ID` /
 * `_SECRET`). The consumer's permissions are set on the consumer itself, so the
 * authorize URL carries no scope. Token calls authenticate with HTTP basic
 * (client id and secret).
 *
 *   GET  https://bitbucket.org/site/oauth2/authorize?client_id&response_type=code&state&redirect_uri
 *   POST https://bitbucket.org/site/oauth2/access_token   (authorization_code, refresh_token)
 *   GET  https://api.bitbucket.org/2.0/user
 */

import { bitbucketLogin, type BitbucketUser } from '@weldsuite/merge-domain/providers/bitbucket';
import { ProviderNotConfiguredError } from '../errors';
import { bearer, credentialsFromToken, requestJson } from '../provider-http';
import type { OAuthProvider } from '../types';
import type { Env } from '../../../types';
import { BITBUCKET_API } from './client';

const TOKEN_URL = 'https://bitbucket.org/site/oauth2/access_token';

function credentialsOf(env: Env): { clientId: string; clientSecret: string } {
  if (!env.BITBUCKET_OAUTH_CLIENT_ID || !env.BITBUCKET_OAUTH_CLIENT_SECRET) throw new ProviderNotConfiguredError('bitbucket');
  return { clientId: env.BITBUCKET_OAUTH_CLIENT_ID, clientSecret: env.BITBUCKET_OAUTH_CLIENT_SECRET };
}

const basic = (clientId: string, clientSecret: string): Record<string, string> => {
  const pair = btoa(`${clientId}:${clientSecret}`);
  return { Authorization: `Basic ${pair}` };
};

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export const bitbucketOAuth: OAuthProvider = {
  authorizeUrl(env, input) {
    const { clientId } = credentialsOf(env);
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      state: input.state,
      redirect_uri: input.redirectUri,
    });
    return `https://bitbucket.org/site/oauth2/authorize?${params.toString()}`;
  },

  async exchangeCode(env, input) {
    const { clientId, clientSecret } = credentialsOf(env);
    const body = await requestJson<TokenBody>('bitbucket', {
      method: 'POST',
      url: TOKEN_URL,
      headers: basic(clientId, clientSecret),
      form: { grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri },
    });
    return credentialsFromToken(body ?? {}, 'bitbucket');
  },

  async refresh(env, input) {
    const { clientId, clientSecret } = credentialsOf(env);
    const body = await requestJson<TokenBody>('bitbucket', {
      method: 'POST',
      url: TOKEN_URL,
      headers: basic(clientId, clientSecret),
      form: { grant_type: 'refresh_token', refresh_token: input.refreshToken },
    });
    return credentialsFromToken(body ?? {}, 'bitbucket');
  },

  async currentUser(_env, input) {
    const user = await requestJson<BitbucketUser>('bitbucket', {
      method: 'GET',
      url: `${BITBUCKET_API}/user`,
      headers: bearer(input.accessToken),
    });
    if (!user) throw new Error('Bitbucket answered /user with an empty body');
    return {
      externalId: user.uuid ?? user.account_id ?? '',
      login: bitbucketLogin(user) ?? '',
      displayName: user.display_name ?? null,
      avatarUrl: user.links?.avatar?.href ?? null,
    };
  },
};
