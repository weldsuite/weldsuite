/**
 * The WeldDesk Discord and Slack OAuth callbacks
 * (/api/integrations/helpdesk/{discord,slack}/callback) on pglite. They are
 * public: the worker mounts them ahead of the Clerk guard, and the one-time
 * state nonce in the `WORKSPACE_CACHE` KV (written by
 * POST /api/helpdesk-integrations/{discord,slack}/connect) is the credential.
 * The test seeds those nonces itself, with fixed values.
 *
 * Conformance-ready: the master database is shared through
 * `conformanceMasterDb` (the workspace is resolved from the state's org id),
 * the tenant database through `conformanceTenantDb`, the KV namespace is a
 * memory KV the harness shares, and Discord's and Slack's token endpoints
 * are a `fetch` stub answering by method, URL and body. The callbacks are
 * GETs that write (the nonce is spent, the integration upserted), so each
 * request carries the conformance write header: TypeScript runs first on
 * copies, then Rust on the shared state.
 *
 * Redirects answer no body; the harness compares their status, and the
 * assertions here read the `Location` of Rust's answer.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { CONFORMANCE_WRITE_HEADER } from '@weldsuite/worker-kit/testing/conformance';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(holder.master),
    getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
    // The real lookup reads the master database through its own module-level
    // getMasterDb (a Neon handle) and caches in KV; the same query on the
    // test's master database instead.
    getWorkspaceForOrg: async (_env: unknown, ref: string) => {
      const workspace = await actual.selectWorkspaceForRef(conformanceMasterDb(holder.master) as never, ref);
      if (!workspace) throw new Error(`Workspace not found: ${ref}`);
      return { id: workspace.id, clerkOrgId: workspace.clerkOrgId };
    },
  };
});

import { integrationsHelpdeskOAuthRoutes } from './helpdesk-oauth';

const BASE = '/api/integrations/helpdesk';
const ORG = 'org_desk_oauth';
const WORKSPACE = 'ws_desk_oauth';
const APP = 'https://app-test.weldsuite.org';
const CALLER = 'http://localhost:3000';
const DISCORD = 'https://discord.com/api/v10';
const OAUTH_GUILD = '888888888888888888';
const UNKNOWN_GUILD = '999999999999999990';
const hci = schema.helpdeskChannelIntegrations;

let tenantDb: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const kv = createMemoryKv();

// ── Discord and Slack token endpoints ────────────────────────────────────────

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

function discordTokens(form: URLSearchParams): Response {
  const tokens = {
    access_token: 'dc-access',
    token_type: 'Bearer',
    expires_in: 604800,
    refresh_token: 'dc-refresh',
    scope: 'identify bot guilds',
  };
  if (form.get('code') === 'good-code') {
    return Response.json({ ...tokens, guild: { id: OAUTH_GUILD, name: 'OAuth Guild', icon: null, owner_id: '1' } });
  }
  if (form.get('code') === 'no-guild-code') return Response.json(tokens);
  return Response.json({ error: 'invalid_grant' }, { status: 400 });
}

function slackTokens(form: URLSearchParams): Response {
  if (form.get('code') === 'good') {
    return Response.json({
      ok: true,
      access_token: 'xoxb-new',
      token_type: 'bot',
      team: { id: 'T1', name: 'Acme Slack' },
      bot_user_id: 'U_BOT',
    });
  }
  if (form.get('code') === 'noteam') return Response.json({ ok: true, access_token: 'xoxb-noteam' });
  return Response.json({ ok: false, error: 'invalid_code' });
}

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = urlOf(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (url === `${DISCORD}/oauth2/token` && method === 'POST') return discordTokens(formOf(init));
  if (url === `${DISCORD}/guilds/${OAUTH_GUILD}` && method === 'GET') {
    return Response.json({ id: OAUTH_GUILD, name: 'OAuth Guild Live', icon: null, owner_id: '1' });
  }
  if (url.startsWith(`${DISCORD}/`)) return Response.json({ message: 'Unknown Guild', code: 10004 }, { status: 404 });
  if (url === 'https://slack.com/api/oauth.v2.access' && method === 'POST') return slackTokens(formOf(init));
  // The conformance harness's own calls (the Rust server, the bridges).
  return realFetch(input, init);
});

/** The third-party calls since `from`, each once (the stub answers both backends in conformance mode). */
function callsSince(from: number): Array<[string, string, string | null]> {
  const calls = fetchStub.mock.calls
    .slice(from)
    .map(([input, init]): [string, string, string | null] => {
      const body = init?.body;
      const text = body instanceof URLSearchParams ? body.toString() : typeof body === 'string' && body !== '' ? body : null;
      return [(init?.method ?? 'GET').toUpperCase(), urlOf(input), text];
    })
    .filter(([, url]) => !url.startsWith('http://127.0.0.1'));
  return [...new Map(calls.map((c) => [JSON.stringify(c), c])).values()];
}

// ── the app ──────────────────────────────────────────────────────────────────

const ENV = {
  DISCORD_CLIENT_ID: 'dc-client',
  DISCORD_CLIENT_SECRET: 'dc-secret',
  DISCORD_BOT_TOKEN: 'bot-ok',
  SLACK_CLIENT_ID: 'sl-client',
  SLACK_CLIENT_SECRET: 'sl-secret',
};

function app(env: Record<string, unknown> = {}) {
  // The session the harness adds is not read: these routes run ahead of the Clerk guard.
  return createTestApp(BASE, integrationsHelpdeskOAuthRoutes as never, {
    context: { tenantDb, masterDb: master, orgId: null, clerkOrgId: null },
    env: { WORKSPACE_CACHE: kv, ...ENV, ...env } as never,
  });
}

/** A callback GET: it spends the nonce and writes, so both backends run it as a write. */
async function callback(path: string, env: Record<string, unknown> = {}): Promise<{ status: number; location: string | null }> {
  const res = await app(env).request(`${BASE}${path}`, { headers: { [CONFORMANCE_WRITE_HEADER]: '1' } });
  return { status: res.status, location: res.headers.get('location') };
}

/** Stores a state nonce as POST /api/helpdesk-integrations/{provider}/connect does. */
async function seedState(provider: 'discord' | 'slack', state: string, orgId = ORG, callerOrigin = CALLER) {
  await kv.put(`${provider}_oauth_state:${state}`, JSON.stringify({ orgId, userId: 'user_admin', callerOrigin }));
}

const discordPage = (query: string, org: string | null = ORG, base = CALLER) =>
  `${base}${org ? `/w/${org}` : ''}/settings/integrations/discord?${query}`;
const slackPage = (query: string, org: string | null = ORG, base = CALLER) =>
  `${base}${org ? `/w/${org}` : ''}/welddesk/settings/integrations/slack?${query}`;

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub);
  tenantDb = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  holder.tenant = tenantDb;
  await master.insert(masterSchema.workspaces).values({ id: WORKSPACE, clerkOrgId: ORG, name: 'Desk OAuth', slug: 'desk-oauth' });
}, 180_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

// ── Discord ──────────────────────────────────────────────────────────────────

describe('GET /api/integrations/helpdesk/discord/callback', () => {
  it('sends a callback without code or state back to the default app', async () => {
    for (const query of ['', '?code=good-code', '?state=s1']) {
      expect(await callback(`/discord/callback${query}`)).toEqual({
        status: 302,
        location: `${APP}/settings/integrations/discord?error=missing_params`,
      });
    }
    expect(await callback('/discord/callback', { PUBLIC_APP_URL: 'https://desk.example.test/' })).toEqual({
      status: 302,
      location: 'https://desk.example.test/settings/integrations/discord?error=missing_params',
    });
  });

  it('refuses a state it did not issue', async () => {
    expect(await callback('/discord/callback?code=good-code&state=never-issued')).toEqual({
      status: 302,
      location: `${APP}/settings/integrations/discord?error=invalid_state`,
    });
  });

  it('spends the state even when the app is not configured', async () => {
    await seedState('discord', 'dc-config');
    expect(await callback('/discord/callback?code=good-code&state=dc-config', { DISCORD_CLIENT_SECRET: undefined })).toEqual({
      status: 302,
      location: discordPage('error=config_error'),
    });
    expect(kv.store.has('discord_oauth_state:dc-config')).toBe(false);
  });

  it('connects a new server: exchanges the code, names the guild and maps it for the widget API', async () => {
    await seedState('discord', 'dc-new');
    const from = fetchStub.mock.calls.length;
    const { status, location } = await callback('/discord/callback?code=good-code&state=dc-new&guild_id=123');
    expect(status).toBe(302);
    const [row] = await tenantDb.select().from(hci).where(eq(hci.provider, 'discord'));
    expect(location).toBe(discordPage(`connected=true&integrationId=${row!.id}`));
    expect(row).toMatchObject({
      status: 'connected',
      name: 'OAuth Guild Live',
      accountInfo: { id: OAUTH_GUILD, name: 'OAuth Guild Live', metadata: { guildId: OAUTH_GUILD, guildName: 'OAuth Guild Live' } },
      accessToken: 'dc-access',
      refreshToken: 'dc-refresh',
      config: { supportChannels: [], processDirectMessages: false, ignoreBots: true },
      errorMessage: null,
    });
    expect(row!.tokenExpiresAt!.getTime() - row!.createdAt.getTime()).toBe(604_800_000);
    expect(JSON.parse(kv.store.get(`discord_guild:${OAUTH_GUILD}`)!)).toEqual({ clerkOrgId: ORG, internalWorkspaceId: WORKSPACE });
    expect(kv.store.has('discord_oauth_state:dc-new')).toBe(false);
    expect(callsSince(from)).toEqual([
      [
        'POST',
        `${DISCORD}/oauth2/token`,
        'grant_type=authorization_code&code=good-code' +
          '&redirect_uri=https%3A%2F%2Fapp-api-test.weldsuite.org%2Fapi%2Fintegrations%2Fhelpdesk%2Fdiscord%2Fcallback' +
          '&client_id=dc-client&client_secret=dc-secret',
      ],
      ['GET', `${DISCORD}/guilds/${OAUTH_GUILD}`, null],
    ]);
  });

  it('reconnects the same guild in place, naming it from the token answer without a bot token', async () => {
    const [before] = await tenantDb.select().from(hci).where(eq(hci.provider, 'discord'));
    await tenantDb.update(hci).set({ status: 'error', errorMessage: 'Token expired' }).where(eq(hci.id, before!.id));
    await seedState('discord', 'dc-again');
    const { location } = await callback('/discord/callback?code=good-code&state=dc-again', { DISCORD_BOT_TOKEN: undefined });
    expect(location).toBe(discordPage(`connected=true&integrationId=${before!.id}`));
    const rows = await tenantDb.select().from(hci).where(eq(hci.provider, 'discord'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before!.id, status: 'connected', errorMessage: null, name: 'OAuth Guild' });
  });

  it('takes the guild from the query when the token answer has none, and names it generically when Discord does not know it', async () => {
    await seedState('discord', 'dc-param', ORG, '');
    const { location } = await callback(`/discord/callback?code=no-guild-code&state=dc-param&guild_id=${UNKNOWN_GUILD}`);
    const rows = await tenantDb.select().from(hci).where(eq(hci.name, 'Discord Server'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountInfo).toEqual({ id: UNKNOWN_GUILD, name: 'Discord Server', metadata: { guildId: UNKNOWN_GUILD, guildName: 'Discord Server' } });
    // No caller origin in the state: back to the default app, in the workspace.
    expect(location).toBe(discordPage(`connected=true&integrationId=${rows[0]!.id}`, ORG, APP));
  });

  it('refuses a connection without a guild', async () => {
    await seedState('discord', 'dc-noguild');
    expect((await callback('/discord/callback?code=no-guild-code&state=dc-noguild')).location).toBe(
      discordPage('error=missing_guild'),
    );
  });

  it('fails the callback when the code exchange or the workspace lookup fails', async () => {
    await seedState('discord', 'dc-bad');
    expect((await callback('/discord/callback?code=bad-code&state=dc-bad')).location).toBe(discordPage('error=callback_failed'));

    await seedState('discord', 'dc-noworkspace', 'org_unknown');
    expect((await callback('/discord/callback?code=good-code&state=dc-noworkspace')).location).toBe(
      discordPage('error=callback_failed', 'org_unknown'),
    );
  });
});

// ── Slack ────────────────────────────────────────────────────────────────────

describe('GET /api/integrations/helpdesk/slack/callback', () => {
  it('sends a callback without code or state back to the default app', async () => {
    expect(await callback('/slack/callback?code=good')).toEqual({
      status: 302,
      location: `${APP}/welddesk/settings/integrations/slack?error=missing_params`,
    });
  });

  it('refuses a state it did not issue, and an unconfigured app', async () => {
    expect((await callback('/slack/callback?code=good&state=never-issued')).location).toBe(
      `${APP}/welddesk/settings/integrations/slack?error=invalid_state`,
    );
    await seedState('slack', 'sl-config');
    expect((await callback('/slack/callback?code=good&state=sl-config', { SLACK_CLIENT_SECRET: undefined })).location).toBe(
      slackPage('error=config_error'),
    );
    expect(kv.store.has('slack_oauth_state:sl-config')).toBe(false);
  });

  it('passes on what Slack refuses the code with', async () => {
    await seedState('slack', 'sl-bad');
    expect((await callback('/slack/callback?code=bad&state=sl-bad')).location).toBe(slackPage('error=invalid_code'));
    expect(await tenantDb.select().from(hci).where(eq(hci.provider, 'slack'))).toEqual([]);
  });

  it('connects Slack and maps the team for the widget API', async () => {
    await seedState('slack', 'sl-new');
    const from = fetchStub.mock.calls.length;
    const { status, location } = await callback('/slack/callback?code=good&state=sl-new');
    expect(status).toBe(302);
    expect(location).toBe(slackPage('connected=true'));
    const [row] = await tenantDb.select().from(hci).where(eq(hci.provider, 'slack'));
    expect(row).toMatchObject({
      status: 'connected',
      name: 'Acme Slack',
      accountInfo: { id: 'T1', name: 'Acme Slack', metadata: { teamId: 'T1', botUserId: 'U_BOT' } },
      config: { botToken: 'xoxb-new' },
      accessToken: 'xoxb-new',
    });
    expect(JSON.parse(kv.store.get('slack_team:T1')!)).toEqual({ clerkOrgId: ORG, internalWorkspaceId: WORKSPACE });
    expect(callsSince(from)).toEqual([
      [
        'POST',
        'https://slack.com/api/oauth.v2.access',
        'client_id=sl-client&client_secret=sl-secret&code=good' +
          '&redirect_uri=https%3A%2F%2Fapp-api-test.weldsuite.org%2Fapi%2Fintegrations%2Fhelpdesk%2Fslack%2Fcallback',
      ],
    ]);
  });

  it('reconnects in place, keeping the settings, even without a team', async () => {
    const [before] = await tenantDb.select().from(hci).where(eq(hci.provider, 'slack'));
    await tenantDb
      .update(hci)
      .set({ config: { botToken: 'xoxb-new', supportChannels: [{ channelId: 'C1', enabled: true }] } })
      .where(eq(hci.id, before!.id));
    kv.store.delete('slack_team:T1');

    await seedState('slack', 'sl-noteam');
    expect((await callback('/slack/callback?code=noteam&state=sl-noteam')).location).toBe(slackPage('connected=true'));
    const rows = await tenantDb.select().from(hci).where(eq(hci.provider, 'slack'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: before!.id,
      name: 'Slack Workspace',
      accountInfo: { id: 'unknown', name: 'Slack Workspace', metadata: {} },
      config: { botToken: 'xoxb-noteam', supportChannels: [{ channelId: 'C1', enabled: true }] },
    });
    expect(kv.store.has('slack_team:T1')).toBe(false);
  });

  it('fails to the default app when the workspace lookup fails', async () => {
    await seedState('slack', 'sl-noworkspace', 'org_unknown');
    // The Slack callback's failure redirect ignores the state's caller origin.
    expect((await callback('/slack/callback?code=good&state=sl-noworkspace')).location).toBe(
      slackPage('error=callback_failed', 'org_unknown', APP),
    );
  });
});
