/**
 * /api/desk/phone/queue on pglite: the callers waiting for an agent, oldest
 * first, and a member picking one up (their softphone is rung for that call).
 * Telnyx is a fetch stub answering by URL; REALTIME records what is published.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { stubTelnyx } from '../../test/telnyx-stub';
import { decodeState, dialCalls, realtimeStub, stubDial, type DialBody } from '../../test/phone-webhook-harness';
import { deskPhoneRoutes } from './index';

const BASE = '/api/desk/phone/queue';
const ALL = ['conversations:read', 'conversations:update'];

let db: Database;
const telnyx = stubTelnyx();
const realtime = realtimeStub();

function send(
  method: string,
  path: string,
  options: { userId?: string; grants?: string[]; configured?: boolean } = {},
) {
  const { request } = createTestApp('/api/desk/phone', deskPhoneRoutes, {
    context: {
      userId: options.userId ?? 'user_picker',
      workspaceId: 'ws_queue_route',
      clerkOrgId: 'org_queue_route',
      tenantDb: db,
      permissions: permissions(...(options.grants ?? ALL)),
    },
    env: {
      ...(options.configured === false ? {} : { TELNYX_API_KEY: 'telnyx-key', TELNYX_CONNECTION_ID: 'conn-1' }),
      REALTIME: realtime.binding,
    } as never,
  });
  return request(`${BASE}${path}`, { method });
}

function putSoftphone(available: boolean) {
  const { request } = createTestApp('/api/desk/phone', deskPhoneRoutes, {
    context: { userId: 'user_picker', workspaceId: 'ws_queue_route', clerkOrgId: 'org_queue_route', tenantDb: db, permissions: permissions(...ALL) },
    env: { TELNYX_API_KEY: 'telnyx-key', TELNYX_CONNECTION_ID: 'conn-1', REALTIME: realtime.binding } as never,
  });
  return request('/api/desk/phone/softphone', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ available }),
  });
}

const waiting = (id: string, enteredAt: string, values: Partial<typeof schema.voipCalls.$inferInsert> = {}) => ({
  id,
  userId: 'system',
  direction: 'inbound',
  status: 'answered',
  fromNumber: '+31612343000',
  toNumber: '+31201280001',
  providerCallId: `cc-${id}`,
  initiatedAt: new Date(enteredAt),
  queueEnteredAt: new Date(enteredAt),
  ...values,
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.deskVisitors).values([
    { id: 'dvis_qr_1', name: 'Eve', phone: '+31612343001' },
    { id: 'dvis_qr_2', name: '+31612343002', phone: '+31612343002' },
  ]);
  await db.insert(schema.deskConversations).values([
    { id: 'dconv_qr_1', conversationNumber: 7001, title: 'Call from Eve', state: 'open', channel: 'phone', visitorId: 'dvis_qr_1', name: 'Eve Caller' },
    { id: 'dconv_qr_2', conversationNumber: 7002, title: 'Call', state: 'open', channel: 'phone', visitorId: 'dvis_qr_2', name: '+31612343002' },
  ]);
  await db.insert(schema.workspaceMembers).values({ id: 'wm_qr_picker', userId: 'user_picker', name: 'Pat Picker' });
  await db.insert(schema.deskPhoneAgents).values([
    { userId: 'user_picker', available: false, telnyxCredentialId: 'cred-picker', sipUsername: 'sip_picker' },
    { userId: 'user_nocred', available: true },
  ]);
  await db.insert(schema.voipPhoneNumbers).values({ id: 'vpn_qr', provider: 'telnyx', phoneNumber: '+31201280001', countryCode: 'NL', status: 'active' });
  await db.insert(schema.deskPhoneRoutes).values({
    id: 'dpr_qr', voipPhoneNumberId: 'vpn_qr', action: 'agents', options: { ringSeconds: 40 },
  });
  stubDial(telnyx);
}, 180_000);

beforeEach(async () => {
  await db.update(schema.deskPhoneAgents).set({ available: false }).where(eq(schema.deskPhoneAgents.userId, 'user_picker'));
  await db.delete(schema.deskPhoneCallLegs);
  await db.delete(schema.voipCalls);
  realtime.published.length = 0;
});

afterAll(() => vi.unstubAllGlobals());

describe('GET /queue', () => {
  it('is empty when nobody waits', async () => {
    const res = await send('GET', '');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('lists the callers waiting for an agent, oldest first', async () => {
    await db.insert(schema.voipCalls).values([
      waiting('vcall_qr_new', '2026-10-10T10:05:00Z', { deskConversationId: 'dconv_qr_2', departmentId: 'dept_qr', fromNumber: '+31612343002' }),
      waiting('vcall_qr_old', '2026-10-10T10:00:00Z', { deskConversationId: 'dconv_qr_1' }),
      // Not waiting: answered, missed, ended, never queued.
      waiting('vcall_qr_taken', '2026-10-10T09:00:00Z', { agentAnsweredAt: new Date(), outcome: 'answered' }),
      waiting('vcall_qr_missed', '2026-10-10T09:01:00Z', { outcome: 'missed' }),
      waiting('vcall_qr_gone', '2026-10-10T09:02:00Z', { endedAt: new Date() }),
      waiting('vcall_qr_plain', '2026-10-10T09:03:00Z', { queueEnteredAt: null }),
    ]);
    await db.insert(schema.deskPhoneCallLegs).values({ id: 'dleg_qr_1', callId: 'vcall_qr_old', userId: 'user_picker', status: 'ringing' });
    await db.insert(schema.deskPhoneCallLegs).values({ id: 'dleg_qr_2', callId: 'vcall_qr_new', userId: 'user_picker', status: 'ended' });

    const { data } = (await (await send('GET', '')).json()) as { data: unknown[] };
    expect(data).toEqual([
      {
        callId: 'vcall_qr_old',
        conversationId: 'dconv_qr_1',
        fromNumber: '+31612343000',
        callerName: 'Eve Caller',
        departmentId: null,
        waitingSince: '2026-10-10T10:00:00.000Z',
        ringing: true,
      },
      {
        callId: 'vcall_qr_new',
        conversationId: 'dconv_qr_2',
        fromNumber: '+31612343002',
        // The conversation is only named after a number: no name.
        callerName: null,
        departmentId: 'dept_qr',
        waitingSince: '2026-10-10T10:05:00.000Z',
        ringing: false,
      },
    ]);
  });

  it('needs conversations:read', async () => {
    expect((await send('GET', '', { grants: ['conversations:update'] })).status).toBe(403);
  });
});

describe('POST /queue/:callId/pickup', () => {
  it('rings the member’s softphone for that call', async () => {
    await db.insert(schema.voipCalls).values(waiting('vcall_qr_pick', '2026-10-10T10:00:00Z', { deskConversationId: 'dconv_qr_1' }));
    const mark = telnyx.calls.length;
    const res = await send('POST', '/vcall_qr_pick/pickup');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { callId: 'vcall_qr_pick', ringing: true } });

    const [dial] = dialCalls(telnyx.calls.slice(mark));
    const body = dial!.body as DialBody;
    // The route's ringSeconds, the caller's number, the member's own address.
    expect(body).toMatchObject({ connection_id: 'conn-1', to: 'sip:sip_picker@sip.telnyx.com', from: '+31612343000', timeout_secs: 40 });
    const legs = await db.select().from(schema.deskPhoneCallLegs).where(eq(schema.deskPhoneCallLegs.callId, 'vcall_qr_pick'));
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ userId: 'user_picker', status: 'ringing' });
    expect(decodeState(body.client_state)).toEqual({ workspaceId: 'org_queue_route', agentLegId: legs[0]!.id, parentCallId: 'vcall_qr_pick' });
    const [incoming] = realtime.inbox('user_picker', 'phone.incoming');
    expect(incoming!.data).toMatchObject({
      callId: 'vcall_qr_pick',
      conversationId: 'dconv_qr_1',
      callerName: 'Eve Caller',
      waitingSince: '2026-10-10T10:00:00.000Z',
    });

    // Asking again while that leg rings does not dial a second one.
    const second = await send('POST', '/vcall_qr_pick/pickup');
    expect(await second.json()).toEqual({ data: { callId: 'vcall_qr_pick', ringing: true } });
    expect(dialCalls(telnyx.calls.slice(mark))).toHaveLength(1);
  });

  it('answers 404 for a call that does not exist and 409 for one that is no longer waiting', async () => {
    expect((await send('POST', '/vcall_qr_missing/pickup')).status).toBe(404);
    await db.insert(schema.voipCalls).values([
      waiting('vcall_qr_done', '2026-10-10T10:00:00Z', { agentAnsweredAt: new Date(), outcome: 'answered' }),
      waiting('vcall_qr_over', '2026-10-10T10:00:00Z', { endedAt: new Date() }),
    ]);
    for (const id of ['vcall_qr_done', 'vcall_qr_over']) {
      const res = await send('POST', `/${id}/pickup`);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: { code: 'CONFLICT', message: 'The call is no longer waiting' } });
    }
  });

  it('answers 409 when the member has no softphone credential', async () => {
    await db.insert(schema.voipCalls).values(waiting('vcall_qr_nocred', '2026-10-10T10:00:00Z'));
    for (const userId of ['user_nocred', 'user_never']) {
      const res = await send('POST', '/vcall_qr_nocred/pickup', { userId });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: { code: 'CONFLICT', message: 'You have no softphone credential yet' } });
    }
  });

  it('refuses when the phone service is off, and when the softphone cannot be rung', async () => {
    await db.insert(schema.voipCalls).values(waiting('vcall_qr_off', '2026-10-10T10:00:00Z'));
    const off = await send('POST', '/vcall_qr_off/pickup', { configured: false });
    expect(off.status).toBe(400);
    stubDial(telnyx, () => true);
    const refused = await send('POST', '/vcall_qr_off/pickup');
    expect(refused.status).toBe(502);
    stubDial(telnyx);
    const legs = await db.select().from(schema.deskPhoneCallLegs).where(eq(schema.deskPhoneCallLegs.callId, 'vcall_qr_off'));
    expect(legs.map((l) => l.status)).toEqual(['ended']);
  });

  it('needs conversations:update', async () => {
    expect((await send('POST', '/vcall_qr_x/pickup', { grants: ['conversations:read'] })).status).toBe(403);
  });
});

describe('switching "take calls" on with a caller waiting', () => {
  it('rings the oldest waiting caller, once per switch', async () => {
    await db.insert(schema.voipCalls).values([
      waiting('vcall_qr_w2', '2026-10-10T10:01:00Z'),
      waiting('vcall_qr_w1', '2026-10-10T10:00:00Z', { deskConversationId: 'dconv_qr_1' }),
    ]);
    const mark = telnyx.calls.length;
    expect((await putSoftphone(true)).status).toBe(200);
    const dials = dialCalls(telnyx.calls.slice(mark));
    expect(dials).toHaveLength(1);
    expect(dials[0]!.body).toMatchObject({ to: 'sip:sip_picker@sip.telnyx.com', timeout_secs: 40 });
    expect(decodeState((dials[0]!.body as DialBody).client_state).parentCallId).toBe('vcall_qr_w1');

    // On again, no change: nothing is dialled, even with no leg ringing.
    await db.delete(schema.deskPhoneCallLegs);
    await putSoftphone(true);
    expect(dialCalls(telnyx.calls.slice(mark))).toHaveLength(1);

    // Off and on is a change.
    await putSoftphone(false);
    expect(dialCalls(telnyx.calls.slice(mark))).toHaveLength(1);
    await putSoftphone(true);
    expect(dialCalls(telnyx.calls.slice(mark))).toHaveLength(2);
  });

  it('skips a caller whose newest leg failed within 10 seconds', async () => {
    await db.insert(schema.voipCalls).values(waiting('vcall_qr_f1', '2026-10-10T10:00:00Z'));
    await db.insert(schema.deskPhoneCallLegs).values({ id: 'dleg_qr_fail', callId: 'vcall_qr_f1', userId: 'user_nocred', status: 'ended', endedAt: new Date() });
    const mark = telnyx.calls.length;
    await putSoftphone(true);
    expect(dialCalls(telnyx.calls.slice(mark))).toHaveLength(0);

    // The same leg, had it rung for 30 s, does not block the caller.
    await db.update(schema.deskPhoneCallLegs).set({ createdAt: new Date(Date.now() - 30_000) }).where(eq(schema.deskPhoneCallLegs.id, 'dleg_qr_fail'));
    await putSoftphone(false);
    await putSoftphone(true);
    expect(dialCalls(telnyx.calls.slice(mark))).toHaveLength(1);
  });

  it('does nothing when nobody waits, and still answers 200', async () => {
    const mark = telnyx.calls.length;
    expect((await putSoftphone(true)).status).toBe(200);
    expect(dialCalls(telnyx.calls.slice(mark))).toHaveLength(0);
  });
});
