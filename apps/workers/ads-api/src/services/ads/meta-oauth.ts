import type { Env } from '../../types';

const STATE_TTL_SECONDS = 600;

export interface AdsOAuthState {
  orgId: string;
  userId: string;
  platform: 'facebook';
}

export function adsOAuthRedirectUri(env: Env): string {
  const base = env.PUBLIC_APP_URL || 'https://app.weldsuite.org';
  return `${base.replace(/\/$/, '')}/weldads/connect/callback`;
}

export function facebookCredentials(env: Env): { appId?: string; appSecret?: string } {
  return {
    appId: env.FACEBOOK_APP_ID,
    appSecret: env.FACEBOOK_APP_SECRET,
  };
}

export async function storeAdsOAuthState(
  kv: KVNamespace,
  state: string,
  value: AdsOAuthState,
): Promise<void> {
  await kv.put(`ads_oauth_state:${state}`, JSON.stringify(value), {
    expirationTtl: STATE_TTL_SECONDS,
  });
}

export async function consumeAdsOAuthState(
  kv: KVNamespace,
  state: string,
  orgId: string,
): Promise<AdsOAuthState | null> {
  const stored = (await kv.get(`ads_oauth_state:${state}`, 'json')) as AdsOAuthState | null;
  if (!stored || stored.orgId !== orgId) return null;
  await kv.delete(`ads_oauth_state:${state}`);
  return stored;
}

export function adsConnectionKvKey(platformAccountId: string): string {
  return `adsconn:${platformAccountId}`;
}

export async function writeAdAccountKvMapping(
  kv: KVNamespace,
  platformAccountId: string,
  mapping: { workspaceId: string; connectionId: string; clerkOrgId: string },
): Promise<void> {
  await kv.put(adsConnectionKvKey(platformAccountId), JSON.stringify(mapping));
}

export async function deleteAdAccountKvMapping(kv: KVNamespace, platformAccountId: string): Promise<void> {
  await kv.delete(adsConnectionKvKey(platformAccountId));
}
