/**
 * /api/desk/phone/sip-trunks on pglite: a customer's own phone system as a
 * Telnyx IP or credential connection, its numbers (registered in the master
 * registry like hosted numbers) and the caller id verification. Telnyx is a
 * fetch stub answering by method and URL, shared with the Rust server in
 * conformance mode; the master registry is a pglite too.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  DESK_SIP_TRUNK_AUTH_MODES,
  DESK_SIP_TRUNK_PROVIDERS,
  DESK_SIP_TRUNK_STATUSES,
  DESK_SIP_TRUNK_TRANSPORTS,
  deskSipTrunkCreatedSchema,
  deskSipTrunkSchema,
} from '@weldsuite/core-api-client/schemas/desk-sip-trunks';
import {
  SIP_TRUNK_AUTH_MODES,
  SIP_TRUNK_PROVIDERS,
  SIP_TRUNK_STATUSES,
  SIP_TRUNK_TRANSPORTS,
} from '@weldsuite/db/schema/voip-sip-trunks';
import { json, stubTelnyx, telnyxError, type TelnyxCall } from '../../test/telnyx-stub';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(holder.master) };
});

import { deskPhoneSipTrunkRoutes } from './sip-trunks';

const BASE = '/api/desk/phone/sip-trunks';
const ORG = 'org_test_default';
const ENV = { TELNYX_API_KEY: 'telnyx-key', TELNYX_CONNECTION_ID: 'conn-1' };

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const telnyx = stubTelnyx();

interface Options {
  configured?: boolean;
  grants?: string[];
  env?: Record<string, unknown>;
}

function send(method: string, path: string, body?: unknown, options: Options = {}) {
  const { request } = createTestApp(BASE, deskPhoneSipTrunkRoutes, {
    context: {
      tenantDb: db,
      masterDb: master,
      permissions: permissions(...(options.grants ?? ['conversations:read', 'settings:manage'])),
    },
    env: { ...(options.configured === false ? {} : ENV), ...options.env } as never,
  });
  return request(`${BASE}${path === '/' ? '' : path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

const dataOf = async <T = Record<string, unknown>>(res: Response) => ((await res.json()) as { data: T }).data;
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

const callsTo = (method: string, prefix: string, from = 0) =>
  telnyx.calls.slice(from).filter((c) => c.method === method && c.url.pathname.startsWith(`/v2${prefix}`));
const bodyOf = (call: TelnyxCall | undefined) => call?.body as Record<string, unknown>;

async function registry(phoneNumber: string) {
  const [row] = await master
    .select()
    .from(masterSchema.phoneNumberRegistry)
    .where(eq(masterSchema.phoneNumberRegistry.phoneNumber, phoneNumber));
  return row as { isActive: boolean; voipPhoneNumberId: string; clerkOrgId: string } | undefined;
}

/** Connections are named after their trunk in the stub's answers; every connection can be changed and deleted. */
function stubConnection(name: string) {
  for (const kind of ['ip_connections', 'credential_connections']) {
    const id = `${kind === 'ip_connections' ? 'ipc' : 'crd'}-${name}`;
    telnyx.on('PATCH', `/${kind}/${id}`, { data: { id } });
    telnyx.on('DELETE', `/${kind}/${id}`, () => json({}, 200));
  }
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;

  telnyx.on('POST', '/ip_connections', ({ body }) => {
    const name = (body as { connection_name: string }).connection_name;
    return name === 'Refused' ? telnyxError(422, 'Bad connection') : json({ data: { id: `ipc-${name}` } });
  });
  telnyx.on('POST', '/credential_connections', ({ body }) =>
    json({ data: { id: `crd-${(body as { connection_name: string }).connection_name}` } }),
  );
  telnyx.on('POST', '/ips', ({ body }) => {
    const { ip_address: ip, port } = body as { ip_address: string; port: number };
    return ip === '9.9.9.9' ? telnyxError(422, 'Bad address') : json({ data: { id: `ip-${ip}-${port}` } });
  });
  for (const ip of ['8.8.8.8', '1.1.1.1', '4.4.4.4', '5.5.5.5']) {
    for (const port of [5060, 5070]) telnyx.on('DELETE', `/ips/ip-${ip}-${port}`, () => json({}));
  }
  for (const name of ['XelionIp', 'DstnyCred', 'RollbackPbx', 'VoiceProfile', 'Edit', 'Gone', 'Cleanup', 'Lister', 'Rotate']) {
    stubConnection(name);
  }
  telnyx.on('POST', '/verified_numbers', ({ body }) =>
    (body as { phone_number: string }).phone_number === '+31201300099' ? telnyxError(422, 'Not reachable') : json({ data: {} }),
  );
  telnyx.on('POST', '/verified_numbers/%2B31201300002/actions/verify', ({ body }) => {
    const code = (body as { verification_code: string }).verification_code;
    if (code === '123456') return json({ data: {} });
    return code === '000000' ? telnyxError(404, 'No pending verification') : telnyxError(422, 'Invalid verification code');
  });
  telnyx.on('DELETE', '/verified_numbers/%2B31201300002', () => json({}));
}, 180_000);

afterAll(() => vi.unstubAllGlobals());

describe('schemas and lists stay in step with the database', () => {
  it('mirrors the column lists', () => {
    expect([...DESK_SIP_TRUNK_PROVIDERS]).toEqual([...SIP_TRUNK_PROVIDERS]);
    expect([...DESK_SIP_TRUNK_AUTH_MODES]).toEqual([...SIP_TRUNK_AUTH_MODES]);
    expect([...DESK_SIP_TRUNK_TRANSPORTS]).toEqual([...SIP_TRUNK_TRANSPORTS]);
    expect([...DESK_SIP_TRUNK_STATUSES]).toEqual([...SIP_TRUNK_STATUSES]);
  });
});

describe('creating a trunk', () => {
  it('validates the request', async () => {
    expect((await send('POST', '/', { name: '', authMode: 'ip', ipAddresses: [{ ip: '8.8.8.8' }] })).status).toBe(400);
    expect((await send('POST', '/', { name: 'X', authMode: 'sms' })).status).toBe(400);
    expect((await send('POST', '/', { name: 'X', authMode: 'ip', ipAddresses: [{ ip: '8.8.8.8', port: 70000 }] })).status).toBe(400);
    const none = await send('POST', '/', { name: 'X', authMode: 'ip', ipAddresses: [] });
    expect(none.status).toBe(400);
    expect((await errorOf(none)).code).toBe('ip_required');
    const priv = await send('POST', '/', { name: 'X', authMode: 'ip', ipAddresses: [{ ip: '192.168.1.5' }] });
    expect(priv.status).toBe(400);
    expect((await errorOf(priv)).code).toBe('invalid_ip');
    const twice = await send('POST', '/', { name: 'X', authMode: 'ip', ipAddresses: [{ ip: '8.8.8.8' }, { ip: '8.8.8.8', port: 5060 }] });
    expect((await errorOf(twice)).code).toBe('duplicate_ip');
    const loginWithIps = await send('POST', '/', { name: 'X', authMode: 'credentials', ipAddresses: [{ ip: '8.8.8.8' }] });
    expect((await errorOf(loginWithIps)).code).toBe('ip_not_applicable');
    expect(telnyx.calls.filter((c) => c.method === 'POST' && c.url.pathname === '/v2/ip_connections')).toHaveLength(0);
  });

  it('makes an IP connection with its addresses', async () => {
    const mark = telnyx.calls.length;
    const res = await send('POST', '/', {
      name: 'XelionIp',
      provider: 'xelion',
      authMode: 'ip',
      transport: 'tcp',
      ipAddresses: [{ ip: '8.8.8.8' }, { ip: '1.1.1.1', port: 5070 }],
    });
    expect(res.status).toBe(201);
    const data = await dataOf(res);
    expect(deskSipTrunkCreatedSchema.safeParse(data).success).toBe(true);
    expect(data).toMatchObject({
      name: 'XelionIp',
      provider: 'xelion',
      authMode: 'ip',
      transport: 'tcp',
      status: 'active',
      credentials: null,
      ipAddresses: [{ ip: '8.8.8.8' }, { ip: '1.1.1.1', port: 5070 }],
      numbers: [],
      connection: { port: 5060, transport: 'tcp', username: null, primaryHost: 'sip.telnyx.com' },
    });

    const [connection] = callsTo('POST', '/ip_connections', mark);
    expect(bodyOf(connection)).toEqual({
      connection_name: 'XelionIp',
      active: true,
      webhook_event_url: expect.stringMatching(/^https:\/\/.+\/public\/webhooks\/telnyx$/),
      webhook_api_version: '2',
      outbound: { call_parking_enabled: true },
      transport_protocol: 'TCP',
    });
    const ips = callsTo('POST', '/ips', mark).map(bodyOf);
    expect(ips).toEqual([
      { connection_id: 'ipc-XelionIp', ip_address: '8.8.8.8', port: 5060 },
      { connection_id: 'ipc-XelionIp', ip_address: '1.1.1.1', port: 5070 },
    ]);

    const [row] = await db.select().from(schema.voipSipTrunks).where(eq(schema.voipSipTrunks.name, 'XelionIp'));
    expect(row).toMatchObject({ providerConnectionId: 'ipc-XelionIp', sipUsername: null, createdById: 'user_test_default' });
    expect(row!.ipAddresses).toEqual([
      { ip: '8.8.8.8', providerIpId: 'ip-8.8.8.8-5060' },
      { ip: '1.1.1.1', port: 5070, providerIpId: 'ip-1.1.1.1-5070' },
    ]);
  });

  it('attaches the outbound voice profile when one is configured', async () => {
    const mark = telnyx.calls.length;
    const res = await send(
      'POST',
      '/',
      { name: 'VoiceProfile', authMode: 'ip', ipAddresses: [{ ip: '4.4.4.4' }] },
      { env: { TELNYX_OUTBOUND_VOICE_PROFILE_ID: 'ovp-1', TELNYX_SIP_HOST: 'sip.telnyx.eu' } },
    );
    expect(res.status).toBe(201);
    expect(bodyOf(callsTo('POST', '/ip_connections', mark)[0])).toMatchObject({
      outbound: { call_parking_enabled: true, outbound_voice_profile_id: 'ovp-1' },
      transport_protocol: 'UDP',
    });
    expect(await dataOf(res)).toMatchObject({ connection: { primaryHost: 'sip.telnyx.eu' } });
  });

  it('makes a credential connection and shows the password once', async () => {
    const mark = telnyx.calls.length;
    const res = await send('POST', '/', { name: 'DstnyCred', provider: 'dstny', authMode: 'credentials' });
    expect(res.status).toBe(201);
    const data = await dataOf<{ id: string; credentials: { username: string; password: string }; connection: { username: string } }>(res);
    expect(deskSipTrunkCreatedSchema.safeParse(data).success).toBe(true);

    const sent = bodyOf(callsTo('POST', '/credential_connections', mark)[0]);
    expect(sent).toMatchObject({
      connection_name: 'DstnyCred',
      active: true,
      webhook_api_version: '2',
      outbound: { call_parking_enabled: true },
    });
    expect(sent.user_name).toMatch(/^wd[a-z0-9]+$/);
    expect(String(sent.password)).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9]{24}$/);
    expect(data.credentials).toEqual({ username: sent.user_name, password: sent.password });
    expect(data.connection.username).toBe(sent.user_name);

    // The password is nowhere to be read again.
    const listed = JSON.stringify(await (await send('GET', '/')).json());
    expect(listed).not.toContain(String(sent.password));
    const [row] = await db.select().from(schema.voipSipTrunks).where(eq(schema.voipSipTrunks.id, data.id));
    expect(JSON.stringify(row)).not.toContain(String(sent.password));
    expect(row).toMatchObject({ sipUsername: sent.user_name, providerConnectionId: 'crd-DstnyCred' });
  });

  it('leaves nothing behind when Telnyx refuses', async () => {
    const before = (await db.select().from(schema.voipSipTrunks)).length;
    const refused = await send('POST', '/', { name: 'Refused', authMode: 'ip', ipAddresses: [{ ip: '8.8.8.8' }] });
    expect(refused.status).toBe(400);
    expect((await errorOf(refused)).code).toBe('telnyx_failed');

    const mark = telnyx.calls.length;
    const half = await send('POST', '/', {
      name: 'RollbackPbx',
      authMode: 'ip',
      ipAddresses: [{ ip: '8.8.8.8' }, { ip: '9.9.9.9' }],
    });
    expect(half.status).toBe(400);
    expect(callsTo('DELETE', '/ip_connections/ipc-RollbackPbx', mark)).toHaveLength(1);
    expect((await db.select().from(schema.voipSipTrunks)).length).toBe(before);
  });

  it('answers like the other phone routes when Telnyx is not configured', async () => {
    const res = await send('POST', '/', { name: 'X', authMode: 'credentials' }, { configured: false });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe('Phone service is not activated');
  });
});

describe('changing a trunk', () => {
  let id: string;

  beforeAll(async () => {
    const res = await send('POST', '/', {
      name: 'Edit',
      authMode: 'ip',
      ipAddresses: [{ ip: '8.8.8.8' }, { ip: '1.1.1.1' }],
    });
    id = (await dataOf<{ id: string }>(res)).id;
  });

  it('syncs the addresses by diff', async () => {
    const mark = telnyx.calls.length;
    const res = await send('PATCH', `/${id}`, { ipAddresses: [{ ip: '1.1.1.1' }, { ip: '4.4.4.4' }, { ip: '5.5.5.5', port: 5070 }] });
    expect(res.status).toBe(200);
    expect(callsTo('POST', '/ips', mark).map(bodyOf)).toEqual([
      { connection_id: 'ipc-Edit', ip_address: '4.4.4.4', port: 5060 },
      { connection_id: 'ipc-Edit', ip_address: '5.5.5.5', port: 5070 },
    ]);
    expect(callsTo('DELETE', '/ips', mark).map((c) => c.url.pathname)).toEqual(['/v2/ips/ip-8.8.8.8-5060']);
    // Nothing to change on the connection itself.
    expect(callsTo('PATCH', '', mark)).toHaveLength(0);
    const data = await dataOf<{ ipAddresses: unknown[] }>(res);
    expect(deskSipTrunkSchema.safeParse(data).success).toBe(true);
    expect(data.ipAddresses).toEqual([{ ip: '1.1.1.1' }, { ip: '4.4.4.4' }, { ip: '5.5.5.5', port: 5070 }]);
    const [row] = await db.select().from(schema.voipSipTrunks).where(eq(schema.voipSipTrunks.id, id));
    expect(row!.ipAddresses.map((a) => a.providerIpId)).toEqual(['ip-1.1.1.1-5060', 'ip-4.4.4.4-5060', 'ip-5.5.5.5-5070']);
  });

  it('refuses addresses on a login trunk and bad lists', async () => {
    const login = await dataOf<{ id: string }>(await send('POST', '/', { name: 'Rotate', authMode: 'credentials' }));
    const res = await send('PATCH', `/${login.id}`, { ipAddresses: [{ ip: '8.8.8.8' }] });
    expect((await errorOf(res)).code).toBe('ip_not_applicable');
    expect((await errorOf(await send('PATCH', `/${id}`, { ipAddresses: [] }))).code).toBe('ip_required');
    expect((await send('PATCH', '/strk_missing', { name: 'Y' })).status).toBe(404);
  });

  it('switches the connection off and on, and renames it', async () => {
    const mark = telnyx.calls.length;
    const off = await send('PATCH', `/${id}`, { status: 'disabled' });
    expect(off.status).toBe(200);
    expect(await dataOf(off)).toMatchObject({ status: 'disabled' });
    expect(bodyOf(callsTo('PATCH', '/ip_connections/ipc-Edit', mark)[0])).toEqual({ active: false });

    const on = await send('PATCH', `/${id}`, { status: 'active', provider: 'dstny', transport: 'tls' });
    expect(await dataOf(on)).toMatchObject({ status: 'active', provider: 'dstny', transport: 'tls', connection: { port: 5061 } });
    expect(bodyOf(callsTo('PATCH', '/ip_connections/ipc-Edit', mark)[1])).toEqual({ transport_protocol: 'TLS', active: true });
  });
});

describe('the password', () => {
  it('is replaced on request, and shown once', async () => {
    const [trunk] = await db.select().from(schema.voipSipTrunks).where(eq(schema.voipSipTrunks.name, 'Rotate'));
    const mark = telnyx.calls.length;
    const res = await send('POST', `/${trunk!.id}/rotate-password`);
    expect(res.status).toBe(200);
    const { credentials } = await dataOf<{ credentials: { username: string; password: string } }>(res);
    expect(credentials.username).toBe(trunk!.sipUsername);
    expect(bodyOf(callsTo('PATCH', '/credential_connections/crd-Rotate', mark)[0])).toEqual({ password: credentials.password });
    expect(credentials.password).toMatch(/^[A-Za-z0-9]{24}$/);
  });

  it('only exists for a login trunk', async () => {
    const [trunk] = await db.select().from(schema.voipSipTrunks).where(eq(schema.voipSipTrunks.name, 'XelionIp'));
    const res = await send('POST', `/${trunk!.id}/rotate-password`);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('credentials_only');
    expect((await send('POST', '/strk_missing/rotate-password')).status).toBe(404);
  });
});

describe('numbers', () => {
  let trunkId: string;

  beforeAll(async () => {
    trunkId = (await dataOf<{ id: string }>(await send('POST', '/', { name: 'Lister', authMode: 'credentials' }))).id;
    await master.insert(masterSchema.phoneNumberRegistry).values({
      phoneNumber: '+31201300050',
      clerkOrgId: 'org_someone_else',
      voipPhoneNumberId: 'vpn_elsewhere',
    });
  });

  it('adds a number, registers it and keeps it from outbound until verified', async () => {
    const res = await send('POST', `/${trunkId}/numbers`, { phoneNumber: '0031 20 130 0001', displayName: 'Front desk' });
    expect(res.status).toBe(201);
    const number = await dataOf<{ id: string }>(res);
    expect(number).toMatchObject({
      phoneNumber: '+31201300001',
      displayName: 'Front desk',
      status: 'active',
      allowOutbound: false,
      callerIdVerifiedAt: null,
    });
    const [row] = await db.select().from(schema.voipPhoneNumbers).where(eq(schema.voipPhoneNumbers.id, number.id));
    expect(row).toMatchObject({
      provider: 'sip_trunk',
      sipTrunkId: trunkId,
      providerConnectionId: 'crd-Lister',
      countryCode: 'NL',
      allowInbound: true,
    });
    expect(await registry('+31201300001')).toMatchObject({ isActive: true, clerkOrgId: ORG, voipPhoneNumberId: number.id });
  });

  it('refuses a number that is taken, here or elsewhere', async () => {
    const again = await send('POST', `/${trunkId}/numbers`, { phoneNumber: '+31201300001' });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe('number_taken');
    const elsewhere = await send('POST', `/${trunkId}/numbers`, { phoneNumber: '+31201300050' });
    expect(elsewhere.status).toBe(409);
    expect((await errorOf(elsewhere)).code).toBe('number_taken');
    expect((await registry('+31201300050'))!.clerkOrgId).toBe('org_someone_else');

    const bad = await send('POST', `/${trunkId}/numbers`, { phoneNumber: '12' });
    expect((await errorOf(bad)).code).toBe('invalid_number');
    expect((await send('POST', '/strk_missing/numbers', { phoneNumber: '+31201300009' })).status).toBe(404);
  });

  it('removes a number, frees it and lets it come back', async () => {
    const added = await dataOf<{ id: string }>(await send('POST', `/${trunkId}/numbers`, { phoneNumber: '+31201300003' }));
    expect((await send('DELETE', `/${trunkId}/numbers/${added.id}`)).status).toBe(204);
    const [row] = await db.select().from(schema.voipPhoneNumbers).where(eq(schema.voipPhoneNumbers.id, added.id));
    expect(row!.deletedAt).not.toBeNull();
    expect((await registry('+31201300003'))!.isActive).toBe(false);
    expect((await send('DELETE', `/${trunkId}/numbers/${added.id}`)).status).toBe(404);

    const back = await send('POST', `/${trunkId}/numbers`, { phoneNumber: '+31201300003' });
    expect(back.status).toBe(201);
    expect((await dataOf<{ id: string }>(back)).id).toBe(added.id);
    expect((await registry('+31201300003'))!.isActive).toBe(true);
  });

  it('is listed with the trunk', async () => {
    const listed = await dataOf<Array<{ id: string; numbers: Array<{ phoneNumber: string }> }>>(await send('GET', ''));
    const trunk = listed.find((t) => t.id === trunkId)!;
    expect(trunk.numbers.map((n) => n.phoneNumber)).toEqual(['+31201300001', '+31201300003']);
    expect(deskSipTrunkSchema.safeParse(trunk).success).toBe(true);
  });
});

describe('caller id verification', () => {
  let trunkId: string;
  let numberId: string;

  beforeAll(async () => {
    trunkId = (await dataOf<{ id: string }>(await send('POST', '/', { name: 'Gone', authMode: 'credentials' }))).id;
    numberId = (await dataOf<{ id: string }>(await send('POST', `/${trunkId}/numbers`, { phoneNumber: '+31201300002' }))).id;
  });

  it('asks Telnyx for a code by call or SMS', async () => {
    const mark = telnyx.calls.length;
    const res = await send('POST', `/${trunkId}/numbers/${numberId}/verification`, { method: 'sms' });
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({ method: 'sms', phoneNumber: '+31201300002' });
    expect(bodyOf(callsTo('POST', '/verified_numbers', mark)[0])).toEqual({
      phone_number: '+31201300002',
      verification_method: 'sms',
    });
    expect((await send('POST', `/${trunkId}/numbers/${numberId}/verification`, { method: 'fax' })).status).toBe(400);
  });

  it('refuses a number Telnyx cannot reach', async () => {
    const other = await dataOf<{ id: string }>(await send('POST', `/${trunkId}/numbers`, { phoneNumber: '+31201300099' }));
    const res = await send('POST', `/${trunkId}/numbers/${other.id}/verification`, { method: 'call' });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('verification_refused');
  });

  it('maps a wrong or expired code to a clear error', async () => {
    const wrong = await send('POST', `/${trunkId}/numbers/${numberId}/verification/confirm`, { code: '111111' });
    expect(wrong.status).toBe(400);
    expect((await errorOf(wrong)).code).toBe('wrong_code');
    const expired = await send('POST', `/${trunkId}/numbers/${numberId}/verification/confirm`, { code: '000000' });
    expect(expired.status).toBe(400);
    expect((await errorOf(expired)).code).toBe('code_expired');
    expect((await send('POST', `/${trunkId}/numbers/${numberId}/verification/confirm`, { code: 'abc' })).status).toBe(400);
    const [row] = await db.select().from(schema.voipPhoneNumbers).where(eq(schema.voipPhoneNumbers.id, numberId));
    expect(row).toMatchObject({ callerIdVerifiedAt: null, allowOutbound: false });
  });

  it('opens the number for outbound caller id once confirmed', async () => {
    const mark = telnyx.calls.length;
    const res = await send('POST', `/${trunkId}/numbers/${numberId}/verification/confirm`, { code: '123456' });
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toMatchObject({ phoneNumber: '+31201300002', allowOutbound: true, callerIdVerifiedAt: expect.any(String) });
    expect(bodyOf(callsTo('POST', '/verified_numbers/', mark)[0])).toEqual({ verification_code: '123456' });
    const [row] = await db.select().from(schema.voipPhoneNumbers).where(eq(schema.voipPhoneNumbers.id, numberId));
    expect(row!.callerIdVerifiedAt).not.toBeNull();
    expect(row!.allowOutbound).toBe(true);

    const again = await send('POST', `/${trunkId}/numbers/${numberId}/verification`, { method: 'call' });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe('already_verified');
  });

  it('is cleaned up with the trunk, a Telnyx 404 counting as done', async () => {
    telnyx.on('DELETE', '/credential_connections/crd-Gone', () => telnyxError(404, 'Not found'));
    const mark = telnyx.calls.length;
    const res = await send('DELETE', `/${trunkId}`);
    expect(res.status).toBe(204);
    expect(callsTo('DELETE', '/credential_connections/crd-Gone', mark)).toHaveLength(1);
    expect(callsTo('DELETE', '/verified_numbers/%2B31201300002', mark)).toHaveLength(1);
    expect(await db.select().from(schema.voipSipTrunks).where(eq(schema.voipSipTrunks.id, trunkId))).toHaveLength(0);
    const rows = await db.select().from(schema.voipPhoneNumbers).where(eq(schema.voipPhoneNumbers.sipTrunkId, trunkId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.deletedAt !== null)).toBe(true);
    expect((await registry('+31201300002'))!.isActive).toBe(false);
    expect((await send('DELETE', `/${trunkId}`)).status).toBe(404);
  });
});

describe('permissions', () => {
  it('lists with conversations:read, changes only with settings:manage', async () => {
    expect((await send('GET', '/', undefined, { grants: [] })).status).toBe(403);
    expect((await send('GET', '/', undefined, { grants: ['conversations:read'] })).status).toBe(200);
    const body = { name: 'X', authMode: 'credentials' };
    expect((await send('POST', '/', body, { grants: ['conversations:read'] })).status).toBe(403);
    expect((await send('PATCH', '/strk_x', { name: 'Y' }, { grants: ['conversations:read'] })).status).toBe(403);
    expect((await send('DELETE', '/strk_x', undefined, { grants: ['conversations:read'] })).status).toBe(403);
    expect((await send('POST', '/strk_x/rotate-password', undefined, { grants: ['conversations:read'] })).status).toBe(403);
    expect((await send('POST', '/strk_x/numbers', { phoneNumber: '+31201300009' }, { grants: ['conversations:read'] })).status).toBe(403);
  });
});

describe('cleanup', () => {
  it('deletes a trunk with an IP connection and its numbers', async () => {
    const id = (await dataOf<{ id: string }>(await send('POST', '/', { name: 'Cleanup', authMode: 'ip', ipAddresses: [{ ip: '8.8.8.8' }] }))).id;
    await send('POST', `/${id}/numbers`, { phoneNumber: '+31201300077' });
    const mark = telnyx.calls.length;
    expect((await send('DELETE', `/${id}`)).status).toBe(204);
    expect(callsTo('DELETE', '/ip_connections/ipc-Cleanup', mark)).toHaveLength(1);
    expect((await registry('+31201300077'))!.isActive).toBe(false);
  });
});
