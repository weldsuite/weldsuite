/**
 * /api/desk/phone/softphone on pglite: a member's own "take calls" switch and
 * their own Telnyx telephony credential, created on first use and replaced
 * once when Telnyx no longer knows it. Telnyx is a fetch stub answering by URL.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { json, stubTelnyx, telnyxError } from '../../test/telnyx-stub';
import { deskPhoneRoutes } from './index';

const BASE = '/api/desk/phone/softphone';
const ALL = ['conversations:read', 'conversations:update'];

let db: Database;
const telnyx = stubTelnyx();

function send(
  method: string,
  path: string,
  body?: unknown,
  options: { userId?: string; configured?: boolean; grants?: string[]; raw?: string } = {},
) {
  const { request } = createTestApp('/api/desk/phone', deskPhoneRoutes, {
    context: {
      userId: options.userId ?? 'user_soft',
      workspaceId: 'ws_soft',
      tenantDb: db,
      permissions: permissions(...(options.grants ?? ALL)),
    },
    env: (options.configured === false ? {} : { TELNYX_API_KEY: 'telnyx-key', TELNYX_SIP_CONNECTION_ID: 'sip-conn-1' }) as never,
  });
  return request(`${BASE}${path}`, {
    method,
    ...(options.raw !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: options.raw }
      : body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

const credentialCalls = () => telnyx.calls.filter((c) => c.method === 'POST' && c.url.pathname === '/v2/telephony_credentials');
const tokenCalls = () => telnyx.calls.filter((c) => c.url.pathname.endsWith('/token'));
const row = async (userId: string) => (await db.select().from(schema.deskPhoneAgents).where(eq(schema.deskPhoneAgents.userId, userId)))[0];

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  // One credential per name: asked twice for the same name (conformance mode
  // runs a request on both backends), the stub answers with the same one.
  const numbers = new Map<string, number>();
  telnyx.on('POST', '/telephony_credentials', ({ body }) => {
    const name = (body as { name: string }).name;
    if (name.includes('refused')) return telnyxError(422, 'Nope');
    const created = numbers.get(name) ?? numbers.size + 1;
    numbers.set(name, created);
    const id = `cred-${created}`;
    // Every credential can mint a token, except the one made for user_stale2.
    if (!name.includes('user_stale2')) telnyx.on('POST', `/telephony_credentials/${id}/token`, () => new Response(`jwt-for-${id}`));
    return json({ data: { id, sip_username: `sipuser${created}` } });
  });
}, 180_000);

afterAll(() => vi.unstubAllGlobals());

describe('GET /softphone', () => {
  it('reports an unregistered member, and whether Telnyx is set up', async () => {
    expect(await (await send('GET', '')).json()).toEqual({
      data: { configured: true, available: false, registered: false, sipUsername: null },
    });
    expect(await (await send('GET', '', undefined, { configured: false })).json()).toEqual({
      data: { configured: false, available: false, registered: false, sipUsername: null },
    });
  });
});

describe('PUT /softphone', () => {
  it('validates the body', async () => {
    expect((await send('PUT', '', { available: 'yes' })).status).toBe(400);
    expect((await send('PUT', '', {})).status).toBe(400);
    expect((await send('PUT', '', undefined, { raw: 'not json' })).status).toBe(400);
  });

  it('switches the member’s availability, creating their row on first use', async () => {
    expect(await row('user_soft')).toBeUndefined();
    expect(await (await send('PUT', '', { available: true })).json()).toEqual({
      data: { configured: true, available: true, registered: false, sipUsername: null },
    });
    expect(await row('user_soft')).toMatchObject({ available: true, telnyxCredentialId: null });
    expect(await (await send('PUT', '', { available: false })).json()).toMatchObject({ data: { available: false } });
    expect(await (await send('PUT', '', { available: true })).json()).toMatchObject({ data: { available: true } });
    // Another member's switch is theirs alone.
    expect(await (await send('GET', '', undefined, { userId: 'user_other' })).json()).toMatchObject({ data: { available: false } });
  });
});

describe('POST /softphone/token', () => {
  it('creates the member’s own credential once and mints a token from it', async () => {
    const res = await send('POST', '/token');
    expect(await res.json()).toEqual({ data: { token: 'jwt-for-cred-1', configured: true, sipUsername: 'sipuser1' } });
    expect(credentialCalls()).toHaveLength(1);
    expect(credentialCalls()[0]!.body).toEqual({ connection_id: 'sip-conn-1', name: 'weldsuite-desk-ws_soft-user_soft' });
    expect(await row('user_soft')).toMatchObject({ telnyxCredentialId: 'cred-1', sipUsername: 'sipuser1', available: true });

    // The second token reuses it.
    const again = await send('POST', '/token');
    expect(await again.json()).toEqual({ data: { token: 'jwt-for-cred-1', configured: true, sipUsername: 'sipuser1' } });
    expect(credentialCalls()).toHaveLength(1);
    expect(tokenCalls()).toHaveLength(2);

    expect(await (await send('GET', '')).json()).toEqual({
      data: { configured: true, available: true, registered: true, sipUsername: 'sipuser1' },
    });
  });

  it('trims the credential name to what Telnyx accepts', async () => {
    const mark = telnyx.calls.length;
    await send('POST', '/token', undefined, { userId: `user_${'x'.repeat(100)} y/z` });
    const [create] = telnyx.calls.slice(mark).filter((c) => c.url.pathname === '/v2/telephony_credentials');
    const name = (create!.body as { name: string }).name;
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^weldsuite-desk-ws_soft-user_x+$/);
  });

  it('creates a new credential, once, when Telnyx no longer knows the stored one', async () => {
    await db.insert(schema.deskPhoneAgents).values({ userId: 'user_stale', available: true, telnyxCredentialId: 'cred-gone', sipUsername: 'old_sip' });
    telnyx.on('POST', '/telephony_credentials/cred-gone/token', () => telnyxError(404, 'Resource not found'));
    const before = credentialCalls().length;
    const res = await send('POST', '/token', undefined, { userId: 'user_stale' });
    const { data } = (await res.json()) as { data: { token: string; sipUsername: string } };
    expect(data.token).toMatch(/^jwt-for-cred-\d+$/);
    expect(credentialCalls()).toHaveLength(before + 1);
    expect(await row('user_stale')).toMatchObject({ sipUsername: data.sipUsername, available: true });
    expect((await row('user_stale'))!.telnyxCredentialId).not.toBe('cred-gone');
  });

  it('gives up when the new credential does not work either', async () => {
    await db.insert(schema.deskPhoneAgents).values({ userId: 'user_stale2', telnyxCredentialId: 'cred-gone-2', sipUsername: 'old_sip2' });
    telnyx.on('POST', '/telephony_credentials/cred-gone-2/token', () => telnyxError(404, 'Resource not found'));
    const before = credentialCalls().length;
    // The credential made for this user has no token stub: a 404 again.
    const res = await send('POST', '/token', undefined, { userId: 'user_stale2' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate Voice token' } });
    expect(credentialCalls()).toHaveLength(before + 1);
  });

  it('answers without a token when Telnyx is not set up', async () => {
    const mark = telnyx.calls.length;
    const res = await send('POST', '/token', undefined, { configured: false });
    expect(await res.json()).toEqual({ data: { token: null, configured: false, sipUsername: null } });
    expect(telnyx.calls.length).toBe(mark);
  });

  it('answers 500 when Telnyx refuses the credential', async () => {
    const res = await send('POST', '/token', undefined, { userId: 'user_refused' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate Voice token' } });
    expect(await row('user_refused')).toBeUndefined();
  });
});

describe('permissions', () => {
  it('needs conversations:read to look and conversations:update to change', async () => {
    expect((await send('GET', '', undefined, { grants: ['conversations:update'] })).status).toBe(403);
    expect((await send('PUT', '', { available: true }, { grants: ['conversations:read'] })).status).toBe(403);
    expect((await send('POST', '/token', undefined, { grants: ['conversations:read'] })).status).toBe(403);
  });
});
