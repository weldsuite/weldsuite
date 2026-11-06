/**
 * Azure DevOps OAuth through Microsoft Entra ID (tenant `organizations`; the
 * Entra app's `AZURE_DEVOPS_CLIENT_ID` / `_SECRET`). The scope is Azure
 * DevOps' own resource id plus `offline_access` for a refresh token.
 *
 *   GET  https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize
 *   POST https://login.microsoftonline.com/organizations/oauth2/v2.0/token   (authorization_code, refresh_token)
 *   GET  https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1
 *   GET  https://app.vssps.visualstudio.com/_apis/accounts?memberId={id}&api-version=7.1   (the organisations)
 */

import { ProviderNotConfiguredError } from '../errors';
import { bearer, credentialsFromToken, requestJson } from '../provider-http';
import type { OAuthProvider } from '../types';
import type { Env } from '../../../types';

const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
export const AZURE_DEVOPS_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default offline_access';
const VSSPS = 'https://app.vssps.visualstudio.com/_apis';

function credentialsOf(env: Env): { clientId: string; clientSecret: string } {
  if (!env.AZURE_DEVOPS_CLIENT_ID || !env.AZURE_DEVOPS_CLIENT_SECRET) throw new ProviderNotConfiguredError('azure_devops');
  return { clientId: env.AZURE_DEVOPS_CLIENT_ID, clientSecret: env.AZURE_DEVOPS_CLIENT_SECRET };
}

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface ProfileBody {
  id: string;
  displayName?: string | null;
  emailAddress?: string | null;
  publicAlias?: string | null;
}

export interface AzureOrganization {
  name: string;
  url: string;
}

/** The organisations the signed-in member belongs to, as `https://dev.azure.com/<name>`. */
export async function listAzureOrganizations(accessToken: string, memberId: string): Promise<AzureOrganization[]> {
  const body = await requestJson<{ value?: Array<{ accountName: string }> }>('azure_devops', {
    method: 'GET',
    url: `${VSSPS}/accounts?memberId=${encodeURIComponent(memberId)}&api-version=7.1`,
    headers: bearer(accessToken),
  });
  return (body?.value ?? []).map((account) => ({
    name: account.accountName,
    url: `https://dev.azure.com/${account.accountName}`,
  }));
}

export const azureOAuth: OAuthProvider = {
  authorizeUrl(env, input) {
    const { clientId } = credentialsOf(env);
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: input.redirectUri,
      response_mode: 'query',
      scope: AZURE_DEVOPS_SCOPE,
      state: input.state,
    });
    return `${AUTHORITY}/authorize?${params.toString()}`;
  },

  async exchangeCode(env, input) {
    const { clientId, clientSecret } = credentialsOf(env);
    const body = await requestJson<TokenBody>('azure_devops', {
      method: 'POST',
      url: `${AUTHORITY}/token`,
      form: {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        scope: AZURE_DEVOPS_SCOPE,
      },
    });
    return credentialsFromToken(body ?? {}, 'azure_devops');
  },

  async refresh(env, input) {
    const { clientId, clientSecret } = credentialsOf(env);
    const body = await requestJson<TokenBody>('azure_devops', {
      method: 'POST',
      url: `${AUTHORITY}/token`,
      form: {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        scope: AZURE_DEVOPS_SCOPE,
      },
    });
    return credentialsFromToken(body ?? {}, 'azure_devops');
  },

  async currentUser(_env, input) {
    const profile = await requestJson<ProfileBody>('azure_devops', {
      method: 'GET',
      url: `${VSSPS}/profile/profiles/me?api-version=7.1`,
      headers: bearer(input.accessToken),
    });
    if (!profile) throw new Error('Azure DevOps answered the profile with an empty body');
    return {
      externalId: profile.id,
      login: (profile.emailAddress ?? profile.publicAlias ?? profile.id).toLowerCase(),
      displayName: profile.displayName ?? null,
      avatarUrl: null,
    };
  },
};
