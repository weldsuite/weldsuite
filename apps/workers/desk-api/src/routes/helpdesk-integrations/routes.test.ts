/**
 * Every /api/helpdesk-integrations route on pglite, refusals included: the
 * WeldDesk Discord/Slack channel integrations (`helpdesk_channel_integrations`),
 * token-based integrations, the OAuth starts (state nonces in the
 * `WORKSPACE_CACHE` KV), the Discord bot profile, channels, ticket panel and
 * messages, connection tests, token refresh and disconnect.
 *
 * Conformance-ready: Discord's and Slack's APIs are a `fetch` stub that
 * answers by method, URL, token and body (never by call order), so the
 * harness compares both backends' outbound calls; the KV namespace is a
 * memory KV the harness shares with Rust.
 *
 * `resolveDiscordIntegration` without an `integrationId` takes "the first"
 * live Discord row (`LIMIT 1`, no order). Those calls run while only one
 * Discord row is live; the multi-server tests further down pass the id.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { helpdeskIntegrationsRoutes } from './index';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const BASE = '/api/helpdesk-integrations';
const ORG = 'org_test_default';
const USER = 'user_test_default';
const DISCORD = 'https://discord.com/api/v10';
const GUILD = '111111111111111111';
const BROKEN_GUILD = '555555555555555555';
const SUPPORT_CHANNEL = '222222222222222222';
const GENERAL_CHANNEL = '333333333333333333';
const FORBIDDEN_CHANNEL = '999999999999999999';
const hci = schema.helpdeskChannelIntegrations;

let db: Database;
const kv = createMemoryKv();

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));

// ── Discord and Slack, answered by method + URL (+ token / body) ─────────────

const realFetch = globalThis.fetch;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function formOf(init?: RequestInit): URLSearchParams {
  const body = init?.body;
  if (body instanceof URLSearchParams) return body;
  return new URLSearchParams(typeof body === 'string' ? body : '');
}

const discordError = (status: number, message: string) => Response.json({ message, code: 0 }, { status });

function discordTokens(grant: URLSearchParams): Response {
  if (grant.get('grant_type') === 'refresh_token') {
    if (grant.get('refresh_token') !== 'dc-refresh') return Response.json({ error: 'invalid_grant' }, { status: 400 });
    return Response.json({
      access_token: 'dc-access-2',
      token_type: 'Bearer',
      expires_in: 604800,
      refresh_token: 'dc-refresh-2',
      scope: 'identify bot guilds',
    });
  }
  return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
}

function discordMessage(channelId: string): Response {
  if (channelId === FORBIDDEN_CHANNEL) return discordError(403, 'Missing Access');
  return Response.json({
    id: '777000000000000001',
    channel_id: channelId,
    content: '',
    timestamp: '2026-01-01T12:00:00.000Z',
    author: { id: '123', username: 'WeldBot', discriminator: '0', avatar: null, bot: true },
  });
}

function discord(method: string, path: string, init?: RequestInit): Response {
  const auth = new Headers(init?.headers).get('authorization');
  if (path === '/users/@me' && method === 'GET') {
    if (auth !== 'Bot bot-ok') return discordError(401, '401: Unauthorized');
    return Response.json({ id: '123', username: 'WeldBot', discriminator: '0', avatar: null, bot: true });
  }
  if (path === '/users/@me' && method === 'PATCH') return Response.json({ id: '123', username: 'WeldBot' });
  if (path === `/guilds/${GUILD}/members/@me` && method === 'PATCH') return Response.json({ nick: null });
  if (path === `/guilds/${GUILD}/channels` && method === 'GET') {
    return Response.json([
      { id: SUPPORT_CHANNEL, name: 'support', type: 0, position: 1, parent_id: null, topic: null },
      { id: GENERAL_CHANNEL, name: 'general', type: 0, position: 0, parent_id: null, topic: null },
      { id: '444444444444444444', name: 'Lounge', type: 2, position: 2, parent_id: null, topic: null },
    ]);
  }
  if (path === `/guilds/${BROKEN_GUILD}/channels`) return discordError(500, 'Internal Server Error');
  const message = /^\/channels\/(\d+)\/messages$/.exec(path);
  if (message && method === 'POST') return discordMessage(message[1]!);
  if (path === '/oauth2/token' && method === 'POST') return discordTokens(formOf(init));
  return discordError(404, `Unknown route ${method} ${path}`);
}

function slack(path: string, init?: RequestInit): Response {
  const token = new Headers(init?.headers).get('authorization');
  if (path === '/api/auth.test') {
    if (token !== 'Bearer xoxb-good') return Response.json({ ok: false, error: 'invalid_auth' });
    return Response.json({ ok: true, user_id: 'U_BOT', team: 'Acme' });
  }
  if (path === '/api/conversations.list?types=public_channel&exclude_archived=true&limit=200') {
    if (token !== 'Bearer xoxb-good') return Response.json({ ok: false, error: 'missing_scope' });
    return Response.json({ ok: true, channels: [{ id: 'C1', name: 'support' }, { id: 'C2', name: 'random' }] });
  }
  return Response.json({ ok: false, error: 'unknown_method' });
}

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = urlOf(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (url.startsWith(DISCORD)) return discord(method, url.slice(DISCORD.length), init);
  if (url.startsWith('https://slack.com')) return slack(url.slice('https://slack.com'.length), init);
  if (url === 'https://cdn.example.test/new.png') {
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png; charset=binary' } });
  }
  if (url.startsWith('https://cdn.example.test/')) return new Response('missing', { status: 404 });
  // The conformance harness's own calls (the Rust server, the bridges).
  return realFetch(input, init);
});

// ── the app ──────────────────────────────────────────────────────────────────

const ENV = { DISCORD_BOT_TOKEN: 'bot-ok', DISCORD_CLIENT_ID: 'dc-client', DISCORD_CLIENT_SECRET: 'dc-secret', SLACK_CLIENT_ID: 'sl-client' };

function app(keys: string[], env: Record<string, unknown> = {}, orgId: string | null = ORG) {
  return createTestApp(BASE, helpdeskIntegrationsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, orgId },
    env: { WORKSPACE_CACHE: kv, ...ENV, ...env } as never,
  });
}

const reader = (env: Record<string, unknown> = {}) => app(['settings:read'], env);
const writer = (env: Record<string, unknown> = {}) => app(['settings:update'], env);

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const dataOf = async <T = Record<string, unknown>>(res: Response) => ((await res.json()) as { data: T }).data;

async function seedIntegration(id: string, second: number, values: Partial<typeof hci.$inferInsert>) {
  await db.insert(hci).values({
    id,
    provider: 'discord',
    status: 'connected',
    name: id,
    createdAt: at(second),
    updatedAt: at(second),
    ...values,
  });
}

const guildInfo = (guildId: string, name: string) => ({ id: guildId, name, metadata: { guildId, guildName: name } });

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub);
  db = (await createPgliteDb()).db;
  await seedIntegration('chi_dc1', 1, {
    name: 'Guild One',
    accountInfo: guildInfo(GUILD, 'Guild One'),
    config: {
      supportChannels: [{ channelId: SUPPORT_CHANNEL, channelName: 'support', enabled: true }],
      botDisplayName: 'Helper',
      botAvatarUrl: 'https://cdn.example.test/old.png',
    },
    accessToken: 'dc-access',
    refreshToken: 'dc-refresh',
    tokenExpiresAt: at(100),
  });
  await seedIntegration('chi_tg', 2, {
    provider: 'telegram',
    name: 'Telegram',
    config: { chatId: '42' },
    accessToken: 'tg-token',
  });
  await seedIntegration('chi_dc_gone', 0, {
    name: 'Old Guild',
    status: 'disconnected',
    accountInfo: guildInfo('666666666666666666', 'Old Guild'),
    deletedAt: at(50),
  });
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

// ── refusals ─────────────────────────────────────────────────────────────────

const ROUTES: Array<{ method: string; path: string; write: boolean; body?: unknown }> = [
  { method: 'GET', path: '', write: false },
  { method: 'POST', path: '/token', write: true, body: { provider: 'teams', token: 't' } },
  { method: 'POST', path: '/discord/connect', write: true },
  { method: 'GET', path: '/discord/servers', write: false },
  { method: 'GET', path: '/discord/settings', write: false },
  { method: 'PUT', path: '/discord/settings', write: true, body: { ignoreBots: true } },
  { method: 'GET', path: '/discord/channels', write: false },
  { method: 'POST', path: '/discord/ticket-panel', write: true, body: { channelId: SUPPORT_CHANNEL } },
  { method: 'POST', path: '/discord/send', write: true, body: { channelId: SUPPORT_CHANNEL, content: 'hi' } },
  { method: 'POST', path: '/slack/connect', write: true },
  { method: 'GET', path: '/slack/settings', write: false },
  { method: 'PUT', path: '/slack/settings', write: true, body: { ignoreBots: true } },
  { method: 'GET', path: '/slack/channels', write: false },
  { method: 'POST', path: '/slack/test', write: false },
  { method: 'POST', path: '/discord/test', write: false },
  { method: 'POST', path: '/chi_dc1/refresh', write: true },
  { method: 'DELETE', path: '/chi_dc1', write: true },
  { method: 'GET', path: '/telegram', write: false },
];

function call(request: (input: string, init?: RequestInit) => Promise<Response>, route: (typeof ROUTES)[number]) {
  const init = route.body === undefined ? { method: route.method } : json(route.body, route.method);
  return request(`${BASE}${route.path}`, init);
}

describe('refusals', () => {
  it('needs settings:read to read and settings:update to change', async () => {
    const none = app([]);
    const readOnly = app(['settings:read']);
    const updateOnly = app(['settings:update']);
    for (const route of ROUTES) {
      expect((await call(none.request, route)).status, `${route.method} ${route.path}`).toBe(403);
      const wrongTier = route.write ? readOnly : updateOnly;
      expect((await call(wrongTier.request, route)).status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  it('needs a workspace', async () => {
    const { request } = app(['settings:read', 'settings:update'], {}, null);
    for (const route of ROUTES) {
      const res = await call(request, route);
      expect(res.status, `${route.method} ${route.path}`).toBe(400);
      expect(await res.json()).toEqual({ error: { code: 'ORG_REQUIRED', message: 'Organization context required' } });
    }
  });
});

// ── list, get, token ─────────────────────────────────────────────────────────

describe('GET / and GET /:provider', () => {
  it('lists the live integrations newest first, without their tokens', async () => {
    const res = await reader().request(BASE);
    expect(res.status).toBe(200);
    const { integrations } = await dataOf<{ integrations: Array<Record<string, unknown>> }>(res);
    expect(integrations.map((i) => i.id)).toEqual(['chi_tg', 'chi_dc1']);
    for (const row of integrations) {
      expect(row).not.toHaveProperty('accessToken');
      expect(row).not.toHaveProperty('refreshToken');
    }
    expect(integrations[1]).toMatchObject({
      provider: 'discord',
      status: 'connected',
      name: 'Guild One',
      accountInfo: guildInfo(GUILD, 'Guild One'),
      tokenExpiresAt: at(100).toISOString(),
      deletedAt: null,
    });
  });

  it('gets the integration of a provider', async () => {
    const { request } = reader();
    const telegram = await request(`${BASE}/telegram`);
    expect(telegram.status).toBe(200);
    expect(await dataOf(telegram)).toMatchObject({ id: 'chi_tg', provider: 'telegram', config: { chatId: '42' } });
    expect(await dataOf(await request(`${BASE}/discord`))).toMatchObject({ id: 'chi_dc1' });

    const missing = await request(`${BASE}/teams`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Integration with ID 'teams' not found" } });
  });
});

describe('POST /token', () => {
  it('creates a token integration named after its provider', async () => {
    const res = await writer().request(`${BASE}/token`, json({ provider: 'whatsapp', token: 'wa-token', config: { phone: '+31' } }));
    expect(res.status).toBe(201);
    const created = await dataOf<{ id: string; provider: string; status: string }>(res);
    expect(created).toEqual({ id: expect.stringMatching(/^chi_/), provider: 'whatsapp', status: 'connected' });

    const [row] = await db.select().from(hci).where(eq(hci.id, created.id));
    expect(row).toMatchObject({ name: 'Whatsapp', accessToken: 'wa-token', config: { phone: '+31' }, status: 'connected' });
    expect(row!.lastSyncAt).toBeInstanceOf(Date);
  });

  it('replaces the token of an existing integration, answering the row as it was', async () => {
    await db.update(hci).set({ status: 'error', errorMessage: 'Token revoked' }).where(eq(hci.id, 'chi_tg'));
    const res = await writer().request(`${BASE}/token`, json({ provider: 'telegram', token: 'tg-token-2' }));
    expect(res.status).toBe(200);
    const answered = await dataOf(res);
    expect(answered).toMatchObject({ id: 'chi_tg', status: 'connected', errorMessage: 'Token revoked', config: { chatId: '42' } });
    expect(answered).not.toHaveProperty('accessToken');

    const [row] = await db.select().from(hci).where(eq(hci.id, 'chi_tg'));
    // No new config: the stored one stays.
    expect(row).toMatchObject({ accessToken: 'tg-token-2', status: 'connected', errorMessage: null, config: { chatId: '42' } });
  });

  it.each([
    ['no token', { provider: 'telegram' }],
    ['an empty provider', { provider: '', token: 't' }],
    ['a config that is not an object', { provider: 'telegram', token: 't', config: [1] }],
  ])('rejects %s', async (_label, body) => {
    expect((await writer().request(`${BASE}/token`, json(body))).status).toBe(400);
  });
});

// ── OAuth starts ─────────────────────────────────────────────────────────────

/** The state nonce in an authorize URL, and what the route stored under it. */
async function stateOf(authUrl: string, provider: 'discord' | 'slack') {
  const state = new URL(authUrl).searchParams.get('state')!;
  const stored = await kv.get(`${provider}_oauth_state:${state}`, 'json');
  return { state, stored };
}

describe('POST /discord/connect and /slack/connect', () => {
  it('starts the Discord OAuth flow with a one-time state', async () => {
    const res = await writer().request(`${BASE}/discord/connect`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(res.status).toBe(200);
    const { authUrl } = await dataOf<{ authUrl: string }>(res);
    const { state, stored } = await stateOf(authUrl, 'discord');
    expect(state).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(authUrl).toBe(
      'https://discord.com/oauth2/authorize?client_id=dc-client' +
        '&redirect_uri=https%3A%2F%2Fapp-api-test.weldsuite.org%2Fapi%2Fintegrations%2Fhelpdesk%2Fdiscord%2Fcallback' +
        `&response_type=code&scope=identify+bot+guilds&permissions=360844446720&state=${state}`,
    );
    expect(stored).toEqual({ orgId: ORG, userId: USER, callerOrigin: 'http://localhost:3000' });
  });

  it('starts the Slack OAuth flow, taking the caller from the Referer without its last segment', async () => {
    const res = await writer().request(`${BASE}/slack/connect`, {
      method: 'POST',
      headers: { Referer: 'https://app.example.test/welddesk/settings' },
    });
    expect(res.status).toBe(200);
    const { authUrl } = await dataOf<{ authUrl: string }>(res);
    const { state, stored } = await stateOf(authUrl, 'slack');
    expect(authUrl).toBe(
      'https://slack.com/oauth/v2/authorize?client_id=sl-client' +
        '&redirect_uri=https%3A%2F%2Fapp-api-test.weldsuite.org%2Fapi%2Fintegrations%2Fhelpdesk%2Fslack%2Fcallback' +
        '&scope=channels%3Ahistory%2Cchannels%3Aread%2Cchat%3Awrite%2Cim%3Ahistory%2Cim%3Aread%2Cim%3Awrite%2Cusers%3Aread%2Cusers%3Aread.email' +
        `&state=${state}`,
    );
    expect(stored).toEqual({ orgId: ORG, userId: USER, callerOrigin: 'https://app.example.test/welddesk' });
  });

  it('stores an empty caller when the request names none', async () => {
    const res = await writer().request(`${BASE}/discord/connect`, { method: 'POST' });
    const { stored } = await stateOf((await dataOf<{ authUrl: string }>(res)).authUrl, 'discord');
    expect(stored).toEqual({ orgId: ORG, userId: USER, callerOrigin: '' });
  });

  it('fails without the app client ids', async () => {
    const discord = await writer({ DISCORD_CLIENT_ID: undefined }).request(`${BASE}/discord/connect`, { method: 'POST' });
    expect(discord.status).toBe(500);
    expect(await discord.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Discord client ID not configured' } });
    const slackRes = await writer({ SLACK_CLIENT_ID: undefined }).request(`${BASE}/slack/connect`, { method: 'POST' });
    expect(slackRes.status).toBe(500);
    expect(await slackRes.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Slack client ID not configured' } });
  });
});

// ── Discord, one server ──────────────────────────────────────────────────────

interface DiscordSettings {
  supportChannels: unknown;
  processDirectMessages: boolean;
  ignoreBots: boolean;
  supportPrefix: string;
  autoReplyMessage: string;
  botDisplayName: string;
  botAvatarUrl: string;
  ticketPanel: unknown;
  integrationId: string;
  guildId: string | null;
  guildName?: string;
}

/**
 * The third-party calls since `from`, as `[method, url, body]`, each once: in
 * conformance mode the stub answers both backends' calls (the harness
 * compares the two lists itself).
 */
function discordCallsSince(from: number): Array<[string, string, string | null]> {
  const calls = fetchStub.mock.calls
    .slice(from)
    .map(([input, init]): [string, string, string | null] => [
      (init?.method ?? 'GET').toUpperCase(),
      urlOf(input),
      typeof init?.body === 'string' && init.body !== '' ? init.body : null,
    ])
    .filter(([, url]) => !url.startsWith('http://127.0.0.1'));
  return [...new Map(calls.map((c) => [JSON.stringify(c), c])).values()];
}

describe('Discord settings, one server', () => {
  it('reads the settings with their defaults, and maps the guild for the widget API', async () => {
    kv.store.delete(`discord_guild:${GUILD}`);
    const res = await reader().request(`${BASE}/discord/settings`);
    expect(res.status).toBe(200);
    expect(await dataOf<DiscordSettings>(res)).toEqual({
      supportChannels: [{ channelId: SUPPORT_CHANNEL, channelName: 'support', enabled: true }],
      processDirectMessages: false,
      ignoreBots: true,
      supportPrefix: '',
      autoReplyMessage: '',
      botDisplayName: 'Helper',
      botAvatarUrl: 'https://cdn.example.test/old.png',
      ticketPanel: null,
      integrationId: 'chi_dc1',
      guildId: GUILD,
      guildName: 'Guild One',
    });
    expect(JSON.parse(kv.store.get(`discord_guild:${GUILD}`)!)).toEqual({ clerkOrgId: ORG });
  });

  it('saves the settings and pushes the bot nickname and new avatar to Discord', async () => {
    const from = fetchStub.mock.calls.length;
    const res = await writer().request(
      `${BASE}/discord/settings`,
      json(
        {
          supportChannels: [{ channelId: GENERAL_CHANNEL, enabled: true }],
          processDirectMessages: true,
          ignoreBots: false,
          supportPrefix: '!help',
          autoReplyMessage: 'Thanks, we got it',
          botDisplayName: 'Desk Bot',
          botAvatarUrl: 'https://cdn.example.test/new.png',
          ticketPanel: { channelId: SUPPORT_CHANNEL },
        },
        'PUT',
      ),
    );
    expect(res.status).toBe(200);
    expect(await dataOf<DiscordSettings>(res)).toEqual({
      supportChannels: [{ channelId: GENERAL_CHANNEL, enabled: true }],
      processDirectMessages: true,
      ignoreBots: false,
      supportPrefix: '!help',
      autoReplyMessage: 'Thanks, we got it',
      botDisplayName: 'Desk Bot',
      botAvatarUrl: 'https://cdn.example.test/new.png',
      ticketPanel: {
        channelId: SUPPORT_CHANNEL,
        embedTitle: 'Support Tickets',
        embedDescription: 'Click the button below to open a support ticket.',
        embedColor: '#5865F2',
        buttonText: 'Open a Ticket',
        buttonStyle: 1,
      },
      integrationId: 'chi_dc1',
      guildId: GUILD,
    });
    expect(discordCallsSince(from)).toEqual([
      ['PATCH', `${DISCORD}/guilds/${GUILD}/members/@me`, JSON.stringify({ nick: 'Desk Bot' })],
      ['GET', 'https://cdn.example.test/new.png', null],
      ['PATCH', `${DISCORD}/users/@me`, JSON.stringify({ avatar: 'data:image/png;base64,iVBORw==' })],
    ]);
  });

  it('only touches the avatar when it changed, and resets an emptied nickname and avatar', async () => {
    const { request } = writer();
    let from = fetchStub.mock.calls.length;
    const same = await request(`${BASE}/discord/settings`, json({ botAvatarUrl: 'https://cdn.example.test/new.png' }, 'PUT'));
    expect(same.status).toBe(200);
    expect(discordCallsSince(from)).toEqual([]);

    from = fetchStub.mock.calls.length;
    const cleared = await request(`${BASE}/discord/settings`, json({ botDisplayName: '', botAvatarUrl: '' }, 'PUT'));
    expect(cleared.status).toBe(200);
    expect(await dataOf<DiscordSettings>(cleared)).toMatchObject({ botDisplayName: '', botAvatarUrl: '', supportPrefix: '!help' });
    expect(discordCallsSince(from)).toEqual([
      ['PATCH', `${DISCORD}/guilds/${GUILD}/members/@me`, JSON.stringify({ nick: '' })],
      ['PATCH', `${DISCORD}/users/@me`, JSON.stringify({ avatar: null })],
    ]);
  });

  it('keeps the settings when Discord refuses the avatar', async () => {
    const { request } = writer();
    for (const url of ['https://localhost/x.png', 'http://cdn.example.test/new.png', 'https://cdn.example.test/missing.png']) {
      const res = await request(`${BASE}/discord/settings`, json({ botAvatarUrl: url }, 'PUT'));
      expect(res.status, url).toBe(200);
      expect((await dataOf<DiscordSettings>(res)).botAvatarUrl).toBe(url);
    }
  });

  it('saves without pushing anything when the bot has no token', async () => {
    const from = fetchStub.mock.calls.length;
    const res = await writer({ DISCORD_BOT_TOKEN: undefined }).request(
      `${BASE}/discord/settings`,
      json({ botDisplayName: 'Quiet Bot', botAvatarUrl: 'https://cdn.example.test/new.png' }, 'PUT'),
    );
    expect(res.status).toBe(200);
    expect((await dataOf<DiscordSettings>(res)).botDisplayName).toBe('Quiet Bot');
    expect(discordCallsSince(from)).toEqual([]);
  });

  it.each([
    ['an avatar that is not a URL', { botAvatarUrl: 'not a url' }],
    ['an over-long bot name', { botDisplayName: 'x'.repeat(81) }],
    ['a support channel without its state', { supportChannels: [{ channelId: '1' }] }],
    ['a ticket panel with an unknown button style', { ticketPanel: { channelId: '1', buttonStyle: 5 } }],
  ])('rejects %s', async (_label, body) => {
    expect((await writer().request(`${BASE}/discord/settings`, json(body, 'PUT'))).status).toBe(400);
  });

  it('404s an integration that is not a live Discord one', async () => {
    for (const integrationId of ['chi_tg', 'chi_dc_gone', 'chi_nope']) {
      const read = await reader().request(`${BASE}/discord/settings?integrationId=${integrationId}`);
      expect(read.status).toBe(404);
      expect(await read.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Discord integration not found' } });
      const write = await writer().request(`${BASE}/discord/settings`, json({ integrationId, ignoreBots: true }, 'PUT'));
      expect(write.status).toBe(404);
    }
  });
});

describe('Discord channels, ticket panel and messages, one server', () => {
  it('lists the text channels with their configured state', async () => {
    const res = await reader().request(`${BASE}/discord/channels`);
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({
      integrationId: 'chi_dc1',
      guildId: GUILD,
      guildName: 'Guild One',
      channels: [
        { channelId: SUPPORT_CHANNEL, channelName: 'support', enabled: false },
        { channelId: GENERAL_CHANNEL, channelName: 'general', enabled: true },
      ],
    });
    const noBot = await reader({ DISCORD_BOT_TOKEN: undefined }).request(`${BASE}/discord/channels?integrationId=chi_nope`);
    expect(noBot.status).toBe(500);
    expect(await noBot.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Discord bot token not configured' } });
    expect((await reader().request(`${BASE}/discord/channels?integrationId=chi_tg`)).status).toBe(404);
  });

  it('posts the ticket panel and remembers it on the integration', async () => {
    kv.store.delete(`discord_guild:${GUILD}`);
    const from = fetchStub.mock.calls.length;
    const res = await writer().request(
      `${BASE}/discord/ticket-panel`,
      json({ channelId: SUPPORT_CHANNEL, channelName: 'support', embedTitle: 'Need help?', embedColor: '#ff0000', buttonStyle: 3 }),
    );
    expect(res.status).toBe(200);
    const ticketPanel = {
      channelId: SUPPORT_CHANNEL,
      channelName: 'support',
      embedTitle: 'Need help?',
      embedDescription: 'Click the button below to open a support ticket.',
      embedColor: '#ff0000',
      buttonText: 'Open a Ticket',
      buttonStyle: 3,
      messageId: '777000000000000001',
    };
    expect(await dataOf(res)).toEqual({ messageId: '777000000000000001', ticketPanel, integrationId: 'chi_dc1' });
    expect(discordCallsSince(from)).toEqual([
      [
        'POST',
        `${DISCORD}/channels/${SUPPORT_CHANNEL}/messages`,
        JSON.stringify({
          embeds: [{ title: 'Need help?', description: 'Click the button below to open a support ticket.', color: 0xff0000 }],
          components: [{ type: 1, components: [{ type: 2, style: 3, label: 'Open a Ticket', custom_id: 'open_ticket' }] }],
        }),
      ],
    ]);
    const [row] = await db.select().from(hci).where(eq(hci.id, 'chi_dc1'));
    expect((row!.config as { ticketPanel: unknown }).ticketPanel).toEqual(ticketPanel);
    expect(JSON.parse(kv.store.get(`discord_guild:${GUILD}`)!)).toEqual({ clerkOrgId: ORG });
  });

  it('falls back to the Discord blurple for a black or unreadable colour', async () => {
    for (const embedColor of ['#000000', 'teal']) {
      const from = fetchStub.mock.calls.length;
      const res = await writer().request(`${BASE}/discord/ticket-panel`, json({ integrationId: 'chi_dc1', channelId: SUPPORT_CHANNEL, embedColor }));
      expect(res.status).toBe(200);
      const [, , body] = discordCallsSince(from)[0]!;
      expect(JSON.parse(body as string).embeds[0].color).toBe(0x5865f2);
      // Without a channel name the stored panel has none.
      expect((await dataOf<{ ticketPanel: Record<string, unknown> }>(res)).ticketPanel).not.toHaveProperty('channelName');
    }
  });

  it('fails the ticket panel when Discord refuses it, or the channel id is not a snowflake', async () => {
    for (const channelId of [FORBIDDEN_CHANNEL, '../guilds/1']) {
      const res = await writer().request(`${BASE}/discord/ticket-panel`, json({ channelId }));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to post ticket panel' } });
    }
    const noBot = await writer({ DISCORD_BOT_TOKEN: undefined }).request(`${BASE}/discord/ticket-panel`, json({ channelId: SUPPORT_CHANNEL }));
    expect(noBot.status).toBe(500);
    expect(await noBot.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Discord bot token not configured' } });
    const missing = await writer().request(`${BASE}/discord/ticket-panel`, json({ integrationId: 'chi_tg', channelId: SUPPORT_CHANNEL }));
    expect(missing.status).toBe(404);
  });

  it.each([
    ['no channel', { embedTitle: 'x' }],
    ['an empty channel', { channelId: '' }],
    ['an over-long title', { channelId: SUPPORT_CHANNEL, embedTitle: 'x'.repeat(257) }],
    ['a button style of 0', { channelId: SUPPORT_CHANNEL, buttonStyle: 0 }],
  ])('rejects a ticket panel with %s', async (_label, body) => {
    expect((await writer().request(`${BASE}/discord/ticket-panel`, json(body))).status).toBe(400);
  });

  it('sends a message to a channel and stamps the integration', async () => {
    const res = await writer().request(`${BASE}/discord/send`, json({ channelId: GENERAL_CHANNEL, content: 'Hello from WeldDesk', conversationId: 'conv_1' }));
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({ success: true, messageId: '777000000000000001', message: 'Message sent' });
    const [row] = await db.select().from(hci).where(eq(hci.id, 'chi_dc1'));
    expect(row!.lastSyncAt).toBeInstanceOf(Date);

    const refused = await writer().request(`${BASE}/discord/send`, json({ channelId: FORBIDDEN_CHANNEL, content: 'x' }));
    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to send Discord message' } });
    const noBot = await writer({ DISCORD_BOT_TOKEN: undefined }).request(`${BASE}/discord/send`, json({ channelId: GENERAL_CHANNEL, content: 'x' }));
    expect(noBot.status).toBe(500);
    expect((await writer().request(`${BASE}/discord/send`, json({ channelId: GENERAL_CHANNEL, content: '' }))).status).toBe(400);
  });
});

describe('POST /:provider/test', () => {
  it('checks the Discord bot token against Discord', async () => {
    const ok = await reader().request(`${BASE}/discord/test`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(await dataOf(ok)).toEqual({ success: true, message: 'Connected as WeldBot', details: { botId: '123', botName: 'WeldBot' } });

    const bad = await reader({ DISCORD_BOT_TOKEN: 'bot-bad' }).request(`${BASE}/discord/test`, { method: 'POST' });
    expect(bad.status).toBe(200);
    expect(await dataOf(bad)).toEqual({
      success: false,
      message: 'Discord API error (401): {"message":"401: Unauthorized","code":0}',
    });

    const none = await reader({ DISCORD_BOT_TOKEN: undefined }).request(`${BASE}/discord/test`, { method: 'POST' });
    expect(await dataOf(none)).toEqual({ success: false, message: 'Discord bot token not configured' });
  });

  it('reports whether another provider is connected', async () => {
    const { request } = reader();
    expect(await dataOf(await request(`${BASE}/telegram/test`, { method: 'POST' }))).toEqual({
      success: true,
      message: 'telegram integration is connected',
    });
    expect(await dataOf(await request(`${BASE}/teams/test`, { method: 'POST' }))).toEqual({
      success: false,
      message: 'No teams integration found',
    });
  });
});

// ── Discord, several servers ─────────────────────────────────────────────────

describe('Discord, several servers', () => {
  beforeAll(async () => {
    await seedIntegration('chi_dc_pending', 3, { name: 'Pending Guild', accountInfo: { id: 'unknown', name: 'Pending Guild' } });
    await seedIntegration('chi_dc_broken', 4, {
      name: 'Broken Guild',
      accountInfo: { id: BROKEN_GUILD, name: '' },
      refreshToken: 'dead-refresh',
    });
    await seedIntegration('chi_dc_bare', 5, { name: '', accountInfo: null, config: null });
  });

  it('lists every server, newest first, mapping each guild for the widget API', async () => {
    kv.store.delete(`discord_guild:${GUILD}`);
    const res = await reader().request(`${BASE}/discord/servers`);
    expect(res.status).toBe(200);
    const { servers } = await dataOf<{ servers: Array<Record<string, unknown>> }>(res);
    expect(servers.map((s) => [s.id, s.guildId, s.guildName])).toEqual([
      ['chi_dc_bare', null, 'Discord Server'],
      ['chi_dc_broken', BROKEN_GUILD, 'Broken Guild'],
      ['chi_dc_pending', null, 'Pending Guild'],
      ['chi_dc1', GUILD, 'Guild One'],
    ]);
    expect(servers[0]).not.toHaveProperty('accessToken');
    expect(JSON.parse(kv.store.get(`discord_guild:${GUILD}`)!)).toEqual({ clerkOrgId: ORG });
    expect(JSON.parse(kv.store.get(`discord_guild:${BROKEN_GUILD}`)!)).toEqual({ clerkOrgId: ORG });
  });

  it('reads and saves one server by its id', async () => {
    const read = await reader().request(`${BASE}/discord/settings?integrationId=chi_dc_bare`);
    expect(read.status).toBe(200);
    expect(await dataOf(read)).toMatchObject({ integrationId: 'chi_dc_bare', guildId: null, guildName: 'Discord Server', ignoreBots: true });

    const from = fetchStub.mock.calls.length;
    const saved = await writer().request(
      `${BASE}/discord/settings`,
      json({ integrationId: 'chi_dc_pending', botDisplayName: 'No Guild Bot', supportPrefix: '?' }, 'PUT'),
    );
    expect(saved.status).toBe(200);
    expect(await dataOf(saved)).toMatchObject({ integrationId: 'chi_dc_pending', guildId: null, supportPrefix: '?', botDisplayName: 'No Guild Bot' });
    // No guild: nowhere to set the nickname.
    expect(discordCallsSince(from)).toEqual([]);
  });

  it('refuses the channels of a server without a guild, and fails when Discord does', async () => {
    const pending = await reader().request(`${BASE}/discord/channels?integrationId=chi_dc_pending`);
    expect(pending.status).toBe(400);
    expect(await pending.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'No guild connected' } });

    const broken = await reader().request(`${BASE}/discord/channels?integrationId=chi_dc_broken`);
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });

    const live = await reader().request(`${BASE}/discord/channels?integrationId=chi_dc1`);
    expect(live.status).toBe(200);
  });

  it('posts a ticket panel for a server without a guild, but maps no guild', async () => {
    const res = await writer().request(`${BASE}/discord/ticket-panel`, json({ integrationId: 'chi_dc_pending', channelId: GENERAL_CHANNEL }));
    expect(res.status).toBe(200);
    expect((await dataOf<{ integrationId: string }>(res)).integrationId).toBe('chi_dc_pending');
  });
});

describe('POST /:id/refresh', () => {
  it('refreshes a Discord token', async () => {
    const from = fetchStub.mock.calls.length;
    const res = await writer().request(`${BASE}/chi_dc1/refresh`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await dataOf<Record<string, unknown>>(res);
    expect(data).toMatchObject({ id: 'chi_dc1', status: 'connected', provider: 'discord' });
    expect(data).not.toHaveProperty('accessToken');
    expect(data).not.toHaveProperty('refreshToken');
    expect(Date.parse(data.tokenExpiresAt as string) - Date.now()).toBeGreaterThan(604_000_000);
    expect(discordCallsSince(from)).toEqual([
      [
        'POST',
        `${DISCORD}/oauth2/token`,
        'grant_type=refresh_token&refresh_token=dc-refresh&client_id=dc-client&client_secret=dc-secret',
      ],
    ]);
    const [row] = await db.select().from(hci).where(eq(hci.id, 'chi_dc1'));
    expect(row).toMatchObject({ accessToken: 'dc-access-2', refreshToken: 'dc-refresh-2', errorMessage: null });
  });

  it('fails when Discord refuses the refresh token', async () => {
    const res = await writer().request(`${BASE}/chi_dc_broken/refresh`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to refresh token' } });
  });

  it('refuses what it cannot refresh', async () => {
    const { request } = writer();
    const missing = await request(`${BASE}/chi_nope/refresh`, { method: 'POST' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Integration with ID 'chi_nope' not found" } });

    // By provider name too.
    const telegram = await request(`${BASE}/telegram/refresh`, { method: 'POST' });
    expect(telegram.status).toBe(400);
    expect(await telegram.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Token refresh not supported for telegram' } });

    const noToken = await request(`${BASE}/chi_dc_pending/refresh`, { method: 'POST' });
    expect(noToken.status).toBe(400);
    expect(await noToken.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Cannot refresh token — missing credentials' } });

    const noSecret = await writer({ DISCORD_CLIENT_SECRET: undefined }).request(`${BASE}/chi_dc1/refresh`, { method: 'POST' });
    expect(noSecret.status).toBe(400);
  });
});

// ── Slack ────────────────────────────────────────────────────────────────────

describe('Slack', () => {
  const setSlack = (values: Partial<typeof hci.$inferInsert>) => db.update(hci).set(values).where(eq(hci.id, 'chi_slack'));

  it('404s every Slack route before Slack is connected', async () => {
    const notFound = { error: { code: 'NOT_FOUND', message: 'Slack integration not found' } };
    for (const [method, path, body] of [
      ['GET', '/slack/settings', undefined],
      ['PUT', '/slack/settings', { ignoreBots: false }],
      ['GET', '/slack/channels', undefined],
      ['POST', '/slack/test', undefined],
    ] as const) {
      const { request } = method === 'PUT' ? writer() : reader();
      const res = await request(`${BASE}${path}`, body ? json(body, method) : { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toEqual(notFound);
    }
  });

  it('reads and saves the settings', async () => {
    await seedIntegration('chi_slack', 6, {
      provider: 'slack',
      name: 'Slack',
      config: { supportChannels: [{ channelId: 'C1', enabled: true }], ignoreBots: false, extra: 'kept' },
    });
    const read = await reader().request(`${BASE}/slack/settings`);
    expect(read.status).toBe(200);
    expect(await dataOf(read)).toEqual({ supportChannels: [{ channelId: 'C1', enabled: true }], ignoreBots: false });

    const kept = await writer().request(`${BASE}/slack/settings`, json({ ignoreBots: true }, 'PUT'));
    expect(kept.status).toBe(200);
    expect(await dataOf(kept)).toEqual({ supportChannels: [{ channelId: 'C1', enabled: true }], ignoreBots: true });

    const replaced = await writer().request(`${BASE}/slack/settings`, json({ supportChannels: [] }, 'PUT'));
    expect(await dataOf(replaced)).toEqual({ supportChannels: [], ignoreBots: true });
    const [row] = await db.select().from(hci).where(eq(hci.id, 'chi_slack'));
    expect(row!.config).toEqual({ supportChannels: [], ignoreBots: true, extra: 'kept' });

    expect((await writer().request(`${BASE}/slack/settings`, json({ supportChannels: [{ channelId: 'C1' }] }, 'PUT'))).status).toBe(400);
  });

  it('needs a bot token for the channels and the test', async () => {
    const channels = await reader().request(`${BASE}/slack/channels`);
    expect(channels.status).toBe(400);
    expect(await channels.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'No bot token configured' } });
    expect((await reader().request(`${BASE}/slack/test`, { method: 'POST' })).status).toBe(400);
  });

  it('reports what Slack refuses', async () => {
    await setSlack({ config: { supportChannels: [{ channelId: 'C2', enabled: true }], botToken: 'xoxb-bad' } });
    const channels = await reader().request(`${BASE}/slack/channels`);
    expect(channels.status).toBe(500);
    expect(await channels.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Slack API error: missing_scope' } });

    const test = await reader().request(`${BASE}/slack/test`, { method: 'POST' });
    expect(test.status).toBe(200);
    expect(await dataOf(test)).toEqual({ success: false, message: 'Slack API error: invalid_auth' });
  });

  it('lists the channels and tests the connection with a working token', async () => {
    await setSlack({
      accountInfo: { id: 'T1', name: 'Acme Slack' },
      config: { supportChannels: [{ channelId: 'C2', enabled: true }], botToken: 'xoxb-good' },
    });
    const channels = await reader().request(`${BASE}/slack/channels`);
    expect(channels.status).toBe(200);
    expect(await dataOf(channels)).toEqual({
      teamName: 'Acme Slack',
      channels: [
        { channelId: 'C1', channelName: 'support', enabled: false },
        { channelId: 'C2', channelName: 'random', enabled: true },
      ],
    });

    const test = await reader().request(`${BASE}/slack/test`, { method: 'POST' });
    expect(await dataOf(test)).toEqual({
      success: true,
      message: 'Connection is working',
      details: { botId: 'U_BOT', teamName: 'Acme' },
    });

    await setSlack({ accountInfo: null });
    const unnamed = await reader().request(`${BASE}/slack/channels`);
    expect((await dataOf<{ teamName: string }>(unnamed)).teamName).toBe('Slack Workspace');
  });

  it('lists the Slack bot token with the integration (it lives in config)', async () => {
    const res = await reader().request(`${BASE}/slack`);
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toMatchObject({ id: 'chi_slack', config: { botToken: 'xoxb-good' } });
  });
});

// ── disconnect ───────────────────────────────────────────────────────────────

describe('DELETE /:id', () => {
  it('disconnects a Discord server and drops its guild mapping', async () => {
    await kv.put(`discord_guild:${GUILD}`, JSON.stringify({ clerkOrgId: ORG }));
    const res = await writer().request(`${BASE}/chi_dc1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({ message: 'Disconnected' });
    expect(kv.store.has(`discord_guild:${GUILD}`)).toBe(false);
    const [row] = await db.select().from(hci).where(eq(hci.id, 'chi_dc1'));
    expect(row).toMatchObject({ status: 'disconnected' });
    expect(row!.deletedAt).toBeInstanceOf(Date);

    // Gone from the list, and from the settings.
    expect((await reader().request(`${BASE}/discord/settings?integrationId=chi_dc1`)).status).toBe(404);
  });

  it('disconnects by provider name, and a server without a guild', async () => {
    const { request } = writer();
    expect((await request(`${BASE}/slack`, { method: 'DELETE' })).status).toBe(200);
    expect((await reader().request(`${BASE}/slack/settings`)).status).toBe(404);
    expect((await request(`${BASE}/chi_dc_pending`, { method: 'DELETE' })).status).toBe(200);
  });

  it('404s what is not connected', async () => {
    const { request } = writer();
    const res = await request(`${BASE}/chi_dc1`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Integration with ID 'chi_dc1' not found" } });
    expect((await request(`${BASE}/teams`, { method: 'DELETE' })).status).toBe(404);
  });
});
