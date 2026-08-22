import type { FetchImpl } from './types';

const GRAPH_VERSION = 'v21.0';
const OAUTH_BASE = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export const META_ADS_READ_SCOPES = ['ads_read', 'business_management'] as const;

export interface AuthorizeUrlInput {
  appId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.appId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    state: input.state,
    scope: (input.scopes ?? META_ADS_READ_SCOPES).join(','),
  });
  return `${OAUTH_BASE}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: { message?: string };
}

function parseTokenResponse(json: TokenResponse) {
  if (!json.access_token) {
    throw new Error(json.error?.message ?? 'No access token in Meta response');
  }
  const expiresAt = json.expires_in
    ? new Date(Date.now() + Number(json.expires_in) * 1000).toISOString()
    : undefined;
  return {
    accessToken: json.access_token,
    tokenType: json.token_type,
    expiresAt,
  };
}

export async function exchangeCodeForTokens(
  input: { appId: string; appSecret: string; redirectUri: string; code: string },
  fetchImpl: FetchImpl = fetch,
) {
  const params = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    redirect_uri: input.redirectUri,
    code: input.code,
  });
  const res = await fetchImpl(`${GRAPH_BASE}/oauth/access_token?${params.toString()}`);
  const json = (await res.json()) as TokenResponse;
  if (!res.ok) throw new Error(json.error?.message ?? `Token exchange failed (${res.status})`);
  return parseTokenResponse(json);
}

export async function exchangeForLongLivedToken(
  input: { appId: string; appSecret: string; shortLivedToken: string },
  fetchImpl: FetchImpl = fetch,
) {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: input.appId,
    client_secret: input.appSecret,
    fb_exchange_token: input.shortLivedToken,
  });
  const res = await fetchImpl(`${GRAPH_BASE}/oauth/access_token?${params.toString()}`);
  const json = (await res.json()) as TokenResponse;
  if (!res.ok) throw new Error(json.error?.message ?? `Long-lived exchange failed (${res.status})`);
  return parseTokenResponse(json);
}

export async function getMetaUserProfile(accessToken: string, fetchImpl: FetchImpl = fetch) {
  const params = new URLSearchParams({ fields: 'id,name', access_token: accessToken });
  const res = await fetchImpl(`${GRAPH_BASE}/me?${params.toString()}`);
  const json = (await res.json()) as { id?: string; name?: string; error?: { message?: string } };
  if (!res.ok || !json.id) throw new Error(json.error?.message ?? 'Failed to load Meta user profile');
  return { id: json.id, name: json.name ?? json.id };
}
