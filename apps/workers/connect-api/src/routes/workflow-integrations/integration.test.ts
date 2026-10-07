/**
 * DB-backed integration tests for `/api/workflow-integrations` — the Slack
 * connect/OAuth/test/picker surface (reference provider) plus the Google
 * providers (google_sheets, gmail, google_calendar) that follow the same
 * shape; see "Provider pattern" in docs/plans/weldconnect.md.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { workflowIntegrationsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env, Variables } from '../../types';

/** Minimal in-memory KV stand-in — get/put/delete is all the OAuth flow uses. */
function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string, opts?: 'text' | 'json' | { type?: string }) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      const type = typeof opts === 'string' ? opts : opts?.type;
      return type === 'json' ? JSON.parse(raw) : raw;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  } as unknown as KVNamespace;
}

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function app(kv: KVNamespace) {
  return createTestApp<Env, Variables>('/api/workflow-integrations', workflowIntegrationsRoutes, {
    context: { permissions: permissions('integrations:read', 'integrations:create', 'integrations:update', 'integrations:delete'), tenantDb: db },
    env: {
      WORKSPACE_CACHE: kv,
      SLACK_CLIENT_ID: 'slack-client-id',
      SLACK_CLIENT_SECRET: 'slack-client-secret',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
    },
  }).request;
}

describe('POST /slack/authorize', () => {
  it('returns a Slack authorize URL and stashes the state in KV', async () => {
    const kv = fakeKv();
    const res = await app(kv)('/api/workflow-integrations/slack/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { authorizeUrl: string; state: string } };
    expect(body.data.authorizeUrl).toContain('slack.com/oauth/v2/authorize');
    expect(body.data.authorizeUrl).toContain('client_id=slack-client-id');
    expect(await kv.get(`wf_oauth_state:${body.data.state}`)).not.toBeNull();
  });

  it('refuses an unknown provider', async () => {
    const res = await app(fakeKv())('/api/workflow-integrations/not-a-real-provider/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /slack/callback', () => {
  async function seedState(kv: KVNamespace, state: string) {
    await kv.put(
      `wf_oauth_state:${state}`,
      JSON.stringify({ orgId: 'org_test_default', userId: 'user_test_default', provider: 'slack' }),
    );
  }

  it('exchanges the code, stores the connection and the Slack team KV mapping', async () => {
    const kv = fakeKv();
    await seedState(kv, 'state-1');
    stubFetch(() =>
      new Response(
        JSON.stringify({
          ok: true,
          access_token: 'xoxb-new-token',
          bot_user_id: 'U_BOT',
          team: { id: 'T123', name: 'Acme' },
        }),
        { status: 200 },
      ),
    );

    const res = await app(kv)('/api/workflow-integrations/slack/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'abc', state: 'state-1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; status: string; provider: string } };
    expect(body.data.status).toBe('connected');

    const [row] = await db
      .select()
      .from(schema.workflowIntegrations)
      .where(eq(schema.workflowIntegrations.id, body.data.id));
    expect(row.type).toBe('slack');
    expect(row.status).toBe('connected');
    expect((row.settings as { teamId?: string } | null)?.teamId).toBe('T123');

    expect(await kv.get(`intconn:${body.data.id}`)).not.toBeNull();
    expect(await kv.get('slack_team:T123')).not.toBeNull();
    // The one-time state is consumed.
    expect(await kv.get('wf_oauth_state:state-1')).toBeNull();
  });

  it('rejects an invalid or expired state', async () => {
    const res = await app(fakeKv())('/api/workflow-integrations/slack/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'abc', state: 'does-not-exist' }),
    });
    expect(res.status).toBe(400);
  });

  it('surfaces a Slack-reported token exchange failure', async () => {
    const kv = fakeKv();
    await seedState(kv, 'state-2');
    stubFetch(() => new Response(JSON.stringify({ ok: false, error: 'invalid_code' }), { status: 200 }));

    const res = await app(kv)('/api/workflow-integrations/slack/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bad', state: 'state-2' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('connected Slack integration · test + channel picker', () => {
  async function seedConnectedSlack(): Promise<string> {
    const id = generateId('win');
    await db.insert(schema.workflowIntegrations).values({
      id,
      name: 'Team Slack',
      type: 'slack',
      category: 'communication',
      status: 'connected',
      oauthTokens: { accessToken: 'xoxb-connected' },
      settings: { teamId: 'T_CONNECTED' },
      connectedAt: new Date(),
    });
    return id;
  }

  it('POST /:id/test reports success via auth.test', async () => {
    const id = await seedConnectedSlack();
    stubFetch(() => new Response(JSON.stringify({ ok: true, team: 'Acme' }), { status: 200 }));
    const res = await app(fakeKv())(`/api/workflow-integrations/${id}/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { success: boolean; message: string } };
    expect(body.data.success).toBe(true);
    expect(body.data.message).toContain('Acme');
  });

  it('POST /:id/test reports failure when the token is no longer valid', async () => {
    const id = await seedConnectedSlack();
    stubFetch(() => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 }));
    const res = await app(fakeKv())(`/api/workflow-integrations/${id}/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { success: boolean; message: string } };
    expect(body.data.success).toBe(false);
    expect(body.data.message).toBe('invalid_auth');
  });

  it('GET /:id/slack/channels lists public + private channels, paginating cursors', async () => {
    const id = await seedConnectedSlack();
    let page = 0;
    const { calls } = stubFetch(() => {
      page += 1;
      if (page === 1) {
        return new Response(
          JSON.stringify({
            ok: true,
            channels: [{ id: 'C1', name: 'general', is_private: false, is_member: true }],
            response_metadata: { next_cursor: 'cursor-2' },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          channels: [{ id: 'C2', name: 'secret-team', is_private: true, is_member: false }],
          response_metadata: { next_cursor: '' },
        }),
        { status: 200 },
      );
    });

    const res = await app(fakeKv())(`/api/workflow-integrations/${id}/slack/channels`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; name: string; isPrivate: boolean; isMember: boolean }> };
    expect(body.data).toEqual([
      { id: 'C1', name: 'general', isPrivate: false, isMember: true },
      { id: 'C2', name: 'secret-team', isPrivate: true, isMember: false },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('cursor=cursor-2');
  });

  it('GET /:id/slack/channels surfaces a Slack API error', async () => {
    const id = await seedConnectedSlack();
    stubFetch(() => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 }));
    const res = await app(fakeKv())(`/api/workflow-integrations/${id}/slack/channels`);
    expect(res.status).toBe(500);
  });

  it('GET /:id/slack/channels 400s for a non-Slack integration', async () => {
    const id = generateId('win');
    await db.insert(schema.workflowIntegrations).values({
      id,
      name: 'Some Webhook',
      type: 'http',
      status: 'connected',
    });
    const res = await app(fakeKv())(`/api/workflow-integrations/${id}/slack/channels`);
    expect(res.status).toBe(400);
  });

  it('GET /:id/slack/channels 404s for a missing integration', async () => {
    const res = await app(fakeKv())('/api/workflow-integrations/win_missing/slack/channels');
    expect(res.status).toBe(404);
  });
});

describe('POST /google_sheets/authorize', () => {
  it('returns a Google authorize URL scoped to spreadsheets, stashing the state in KV', async () => {
    const kv = fakeKv();
    const res = await app(kv)('/api/workflow-integrations/google_sheets/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { authorizeUrl: string; state: string } };
    expect(body.data.authorizeUrl).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(body.data.authorizeUrl).toContain('client_id=google-client-id');
    expect(decodeURIComponent(body.data.authorizeUrl)).toContain('auth/spreadsheets');
    // gmail.readonly is deliberately never requested (see GOOGLE_SCOPES.gmail).
    expect(decodeURIComponent(body.data.authorizeUrl)).not.toContain('gmail.readonly');
    expect(decodeURIComponent(body.data.authorizeUrl)).toContain('access_type=offline');
    expect(await kv.get(`wf_oauth_state:${body.data.state}`)).not.toBeNull();
  });
});

describe('POST /gmail/callback', () => {
  it('exchanges the code and stores a connected gmail integration', async () => {
    const kv = fakeKv();
    await kv.put(
      `wf_oauth_state:state-gmail`,
      JSON.stringify({ orgId: 'org_test_default', userId: 'user_test_default', provider: 'gmail' }),
    );
    stubFetch(() =>
      new Response(JSON.stringify({ access_token: 'ya29-new', refresh_token: 'refresh-1', expires_in: 3600 }), {
        status: 200,
      }),
    );

    const res = await app(kv)('/api/workflow-integrations/gmail/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'abc', state: 'state-gmail' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; status: string } };

    const [row] = await db.select().from(schema.workflowIntegrations).where(eq(schema.workflowIntegrations.id, body.data.id));
    expect(row.type).toBe('gmail');
    expect(row.status).toBe('connected');
    const tokens = row.oauthTokens as { accessToken: string; refreshToken?: string; expiresAt?: string };
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.expiresAt).toBeTruthy();
  });

  it('surfaces a Google-reported token exchange failure', async () => {
    const kv = fakeKv();
    await kv.put(
      `wf_oauth_state:state-gmail-2`,
      JSON.stringify({ orgId: 'org_test_default', userId: 'user_test_default', provider: 'gmail' }),
    );
    stubFetch(() => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    const res = await app(kv)('/api/workflow-integrations/gmail/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bad', state: 'state-gmail-2' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('connected Google integrations · test + pickers', () => {
  async function seedConnected(type: string, name: string): Promise<string> {
    const id = generateId('win');
    await db.insert(schema.workflowIntegrations).values({
      id,
      name,
      type,
      status: 'connected',
      oauthTokens: { accessToken: 'ya29-connected' },
      connectedAt: new Date(),
    });
    return id;
  }

  it('POST /:id/test reports success via userinfo for any google* type', async () => {
    const id = await seedConnected('google_sheets', 'My Sheets');
    stubFetch(() => new Response(JSON.stringify({ email: 'jane@acme.com' }), { status: 200 }));
    const res = await app(fakeKv())(`/api/workflow-integrations/${id}/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { success: boolean; message: string } };
    expect(body.data.success).toBe(true);
    expect(body.data.message).toContain('jane@acme.com');
  });

  it('POST /:id/test reports failure when the token is no longer valid', async () => {
    const id = await seedConnected('gmail', 'My Gmail');
    stubFetch(() => new Response('', { status: 401 }));
    const res = await app(fakeKv())(`/api/workflow-integrations/${id}/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { success: boolean; message: string } };
    expect(body.data.success).toBe(false);
  });

  it('GET /:id/google_sheets/spreadsheet resolves a pasted URL, returning the title + sheet tabs', async () => {
    const id = await seedConnected('google_sheets', 'My Sheets');
    const { calls } = stubFetch(() =>
      new Response(
        JSON.stringify({
          properties: { title: 'Leads' },
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/abc123/edit',
          sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }, { properties: { sheetId: 1, title: 'Archive' } }],
        }),
        { status: 200 },
      ),
    );
    const res = await app(fakeKv())(
      `/api/workflow-integrations/${id}/google_sheets/spreadsheet?spreadsheetId=${encodeURIComponent('https://docs.google.com/spreadsheets/d/abc123/edit#gid=0')}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { spreadsheetId: string; title: string; sheets: Array<{ title: string }> } };
    expect(body.data.spreadsheetId).toBe('abc123');
    expect(body.data.title).toBe('Leads');
    expect(body.data.sheets.map((s) => s.title)).toEqual(['Sheet1', 'Archive']);
    expect(calls[0].url).toContain('/spreadsheets/abc123');
  });

  it('GET /:id/google_sheets/spreadsheet 400s when the spreadsheetId query param is missing', async () => {
    const id = await seedConnected('google_sheets', 'My Sheets');
    const res = await app(fakeKv())(`/api/workflow-integrations/${id}/google_sheets/spreadsheet`);
    expect(res.status).toBe(400);
  });

  it('GET /:id/google_sheets/spreadsheet 400s for a non-google_sheets integration', async () => {
    const id = await seedConnected('gmail', 'My Gmail');
    const res = await app(fakeKv())(`/api/workflow-integrations/${id}/google_sheets/spreadsheet?spreadsheetId=abc`);
    expect(res.status).toBe(400);
  });

  it('GET /:id/google_calendar/calendars lists writable calendars, paginating tokens', async () => {
    const id = await seedConnected('google_calendar', 'My Calendar');
    let call = 0;
    const { calls } = stubFetch(() => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            items: [{ id: 'primary', summary: 'Jane', primary: true, accessRole: 'owner' }],
            nextPageToken: 'page-2',
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ items: [{ id: 'team@acme.com', summary: 'Team', accessRole: 'writer' }] }),
        { status: 200 },
      );
    });
    const res = await app(fakeKv())(`/api/workflow-integrations/${id}/google_calendar/calendars`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; summary: string; primary: boolean }> };
    expect(body.data).toEqual([
      { id: 'primary', summary: 'Jane', primary: true, accessRole: 'owner' },
      { id: 'team@acme.com', summary: 'Team', primary: false, accessRole: 'writer' },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('pageToken=page-2');
  });

  it('GET /:id/google_calendar/calendars surfaces a Calendar API error as 500', async () => {
    const id = await seedConnected('google_calendar', 'My Calendar');
    stubFetch(() => new Response('nope', { status: 403 }));
    const res = await app(fakeKv())(`/api/workflow-integrations/${id}/google_calendar/calendars`);
    expect(res.status).toBe(500);
  });
});

describe('PATCH /:id/disconnect', () => {
  it('drops the connection and its KV mappings', async () => {
    const id = generateId('win');
    await db.insert(schema.workflowIntegrations).values({
      id,
      name: 'Team Slack',
      type: 'slack',
      status: 'connected',
      oauthTokens: { accessToken: 'xoxb-connected' },
      settings: { teamId: 'T_DISCONNECT' },
    });
    const kv = fakeKv();
    await kv.put(`intconn:${id}`, JSON.stringify({ workspaceId: 'ws', provider: 'slack' }));
    await kv.put('slack_team:T_DISCONNECT', JSON.stringify({ workspaceId: 'ws', integrationId: id }));

    const res = await app(kv)(`/api/workflow-integrations/${id}/disconnect`, { method: 'PATCH' });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(schema.workflowIntegrations).where(eq(schema.workflowIntegrations.id, id));
    expect(row.status).toBe('disconnected');
    expect(await kv.get(`intconn:${id}`)).toBeNull();
    expect(await kv.get('slack_team:T_DISCONNECT')).toBeNull();
  });
});
