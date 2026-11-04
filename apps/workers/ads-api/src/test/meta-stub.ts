/**
 * A stand-in for Meta's Graph API (`https://graph.facebook.com/v21.0`): the
 * OAuth token exchanges, the user profile, the ad accounts, and campaigns
 * with their insights. It answers by method, URL and body only, never by
 * call order, so the same stub answers both backends in conformance mode
 * (the Rust server's calls reach it through the harness's outbound bridge).
 *
 * Every other URL (the harness's own loopback calls) goes to the real fetch.
 */

import { vi } from 'vitest';

export const GRAPH = 'https://graph.facebook.com/v21.0';

export const FACEBOOK_ENV = {
  FACEBOOK_APP_ID: 'fb-app',
  FACEBOOK_APP_SECRET: 'fb-secret',
  PUBLIC_APP_URL: 'https://app.example.test/',
  // AES-256-GCM key the OAuth tokens are sealed with (`encryptField`).
  DATABASE_ENCRYPTION_KEY_V2: '11'.repeat(32),
};

/** A campaign as Meta stores it (`GET /<campaign id>`). */
export interface MetaCampaignRow {
  id: string;
  name?: string;
  status?: string;
  objective?: string;
  daily_budget?: string;
  lifetime_budget?: string;
}

/** Campaigns Meta knows, by id. */
export const META_CAMPAIGNS: Record<string, MetaCampaignRow> = {
  cmp_new_launch: { id: 'cmp_new_launch', name: 'New launch', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC', daily_budget: '1500' },
  cmp_existing: { id: 'cmp_existing', name: 'Existing renamed', status: 'ACTIVE', objective: 'OUTCOME_SALES', lifetime_budget: '90000' },
  cmp_synced: { id: 'cmp_synced', name: 'Synced remote', status: 'ACTIVE', objective: 'OUTCOME_LEADS', daily_budget: '2500' },
  cmp_unchanged: { id: 'cmp_unchanged', name: 'Unchanged', status: 'PAUSED' },
  cmp_fraction: { id: 'cmp_fraction', name: 'Fraction', status: 'ACTIVE', daily_budget: '10.5' },
  cmp_other_account: { id: 'cmp_other_account', name: 'Other account', status: 'PAUSED', daily_budget: '700' },
};

/** Insights per campaign (`GET /act_<id>/insights?filtering=…`). */
export const META_INSIGHTS: Record<string, Record<string, string>> = {
  cmp_new_launch: { campaign_id: 'cmp_new_launch', spend: '0', impressions: '0', date_start: '2026-10-01', date_stop: '2026-10-30' },
  cmp_existing: {
    campaign_id: 'cmp_existing',
    spend: '12.34',
    impressions: '1000',
    clicks: '40',
    ctr: '4',
    cpc: '0.31',
    reach: '900',
    date_start: '2026-10-01',
    date_stop: '2026-10-30',
  },
  cmp_synced: { campaign_id: 'cmp_synced', spend: '99.5', clicks: '12' },
};

/** Campaign names Meta refuses to create, and ids it refuses to update. */
const REFUSED_NAMES = new Set(['Refused']);
const REFUSED_UPDATES = new Set(['cmp_refused']);

/** Ad accounts per access token (`GET /me/adaccounts`). */
const AD_ACCOUNTS: Record<string, unknown[]> = {
  'long-token': [
    { id: 'act_100', name: 'Main account', account_status: 1, currency: 'EUR', timezone_name: 'Europe/Amsterdam' },
    { id: 'act_200', name: 'Second account', account_status: 2, currency: 'USD' },
  ],
  'long-token-2': [{ id: 'act_100', name: 'Main account (renamed)', account_status: 3, timezone_name: 'Europe/Brussels' }],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const graphError = (message: string, status = 400) => json({ error: { message, type: 'OAuthException' } }, status);

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function formOf(init?: RequestInit): URLSearchParams {
  const body = init?.body;
  if (body instanceof URLSearchParams) return body;
  return new URLSearchParams(typeof body === 'string' ? body : '');
}

/** `/oauth/access_token`: the short-lived exchange, then the long-lived one. */
function tokens(query: URLSearchParams): Response {
  if (query.get('grant_type') === 'fb_exchange_token') {
    const short = query.get('fb_exchange_token');
    if (short === 'short-token') return json({ access_token: 'long-token', token_type: 'bearer', expires_in: 5184000 });
    if (short === 'short-token-2') return json({ access_token: 'long-token-2', token_type: 'bearer' });
    return graphError('Invalid OAuth access token.');
  }
  if (query.get('client_secret') !== 'fb-secret') return graphError('Error validating client secret.');
  switch (query.get('code')) {
    case 'good-code':
      return json({ access_token: 'short-token', token_type: 'bearer', expires_in: 3600 });
    case 'second-code':
      return json({ access_token: 'short-token-2', token_type: 'bearer', expires_in: 3600 });
    case 'no-token-code':
      return json({ token_type: 'bearer' });
    default:
      return graphError('Invalid verification code format.');
  }
}

function graphGet(path: string, query: URLSearchParams): Response {
  const token = query.get('access_token') ?? '';
  if (path === '/oauth/access_token') return tokens(query);
  if (path === '/me') {
    if (token === 'long-token') return json({ id: 'meta_user_1', name: 'Meta User' });
    if (token === 'long-token-2') return json({ id: 'meta_user_1' });
    return graphError('Invalid OAuth access token.', 401);
  }
  if (path === '/me/adaccounts') {
    const accounts = AD_ACCOUNTS[token];
    return accounts ? json({ data: accounts }) : graphError('Invalid OAuth access token.', 401);
  }
  if (/^\/act_[^/]+\/insights$/.test(path)) {
    const filtering = JSON.parse(query.get('filtering') ?? '[]') as Array<{ value: string }>;
    const row = META_INSIGHTS[filtering[0]?.value ?? ''];
    return json({ data: row ? [row] : [] });
  }
  const campaign = META_CAMPAIGNS[path.slice(1)];
  return campaign ? json(campaign) : graphError('Unsupported get request.');
}

function graphPost(path: string, form: URLSearchParams): Response {
  if (/^\/act_[^/]+\/campaigns$/.test(path)) {
    const name = form.get('name') ?? '';
    if (REFUSED_NAMES.has(name)) return graphError('Invalid parameter');
    return json({ id: `cmp_${name.toLowerCase().replaceAll(/\W+/g, '_')}` });
  }
  if (REFUSED_UPDATES.has(path.slice(1))) return graphError('Campaign cannot be edited');
  return json({ success: true });
}

/** The fetch stub; install it with `vi.stubGlobal('fetch', stub)`. */
export function createMetaFetchStub() {
  const realFetch = globalThis.fetch;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (!url.startsWith(`${GRAPH}/`)) return realFetch(input, init);
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/v21\.0/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') return graphPost(path, formOf(init));
    return graphGet(path, parsed.searchParams);
  });
}

/** The Graph calls a stub saw since `from`, each once (both backends call it in conformance mode). */
export function graphCallsSince(stub: ReturnType<typeof createMetaFetchStub>, from: number): string[] {
  const calls = stub.mock.calls
    .slice(from)
    .map(([input, init]) => `${(init?.method ?? 'GET').toUpperCase()} ${urlOf(input)}`)
    .filter((call) => call.includes(GRAPH));
  return sortCalls([...new Set(calls)]);
}

/** Calls in the order {@link graphCallsSince} lists them. */
export function sortCalls(calls: string[]): string[] {
  return [...calls].sort((a, b) => a.localeCompare(b));
}
