/**
 * The `agents` inbound route on pglite: the caller is answered, queued with
 * hold audio and every available member's browser rings on their own softphone
 * credential; the first to answer is bridged and wins the call, the others are
 * hung up; rounds repeat when the ringing runs out; a caller who leaves is
 * abandoned; nobody staffed goes straight to the unanswered path. Telnyx is a
 * fetch stub answering by URL and REALTIME records what is published.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { waitingCallsCondition } from '../../lib/desk-phone-realtime';
import { stubTelnyx, telnyxError } from '../../test/telnyx-stub';
import {
  BASE,
  NUMBERS,
  ORG,
  actionCalls,
  callEvent,
  callOf,
  decodeState,
  deliverWith,
  dialCalls,
  encodeState,
  env,
  legsOf,
  messagesOf,
  realtimeStub,
  seedPhoneWorkspace,
  setRoute,
  stubCallActions,
  stubDial,
  type DialBody,
} from '../../test/phone-webhook-harness';

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(holder.master),
    getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  };
});

import { telnyxWebhookRoutes } from './index';

let db: Database;
const telnyx = stubTelnyx();
const realtime = realtimeStub();

function app() {
  return createTestApp(BASE, telnyxWebhookRoutes as never, {
    context: { tenantDb: db, masterDb: holder.master as Database, orgId: null, clerkOrgId: null },
    env: { ...env(), REALTIME: realtime.binding } as never,
  });
}
const deliver = (event: unknown) => deliverWith(app().request, event);

let controlSeq = 0;
/** An inbound call to one of the seeded numbers; returns its row and the Telnyx calls it caused. */
async function inbound(kind: keyof typeof NUMBERS, from: string) {
  controlSeq += 1;
  const control = `cc-agents-${controlSeq}`;
  stubCallActions(telnyx, control);
  const mark = telnyx.calls.length;
  await deliver(
    callEvent('call.initiated', { direction: 'incoming', call_control_id: control, to: NUMBERS[kind], from, call_session_id: 'sess', call_leg_id: 'leg' }),
  );
  return { control, call: await callOf(db, control), calls: telnyx.calls.slice(mark) };
}

type Leg = typeof schema.deskPhoneCallLegs.$inferSelect;
const legEvent = (type: string, leg: Leg, extra: Record<string, unknown> = {}) =>
  callEvent(type, {
    client_state: encodeState({ workspaceId: ORG, agentLegId: leg.id, parentCallId: leg.callId }),
    call_control_id: leg.providerCallId,
    ...extra,
  });
const legOf = (legs: Leg[], userId: string) => legs.find((l) => l.userId === userId)!;
const callState = async (id: string) => (await db.select().from(schema.voipCalls).where(eq(schema.voipCalls.id, id)))[0]!;
const backdate = (callId: string, ms: number) =>
  db.update(schema.deskPhoneCallLegs).set({ createdAt: new Date(Date.now() - ms) }).where(eq(schema.deskPhoneCallLegs.callId, callId));

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const master = (await createMasterPgliteDb()).db;
  holder.master = master;
  holder.tenant = db;
  await seedPhoneWorkspace(db, master);
  await setRoute(db, 'agents', 'agents', { greeting: 'Welcome to Acme.', ringSeconds: 20, maxWaitSeconds: 120 });
  await setRoute(db, 'team', 'agents', { departmentId: 'dept_q_sales' });
  await setRoute(db, 'hangup', 'agents', { whenUnanswered: 'hangup' });
  await setRoute(db, 'empty', 'agents', { departmentId: 'dept_q_empty', language: 'nl-NL' });
  await setRoute(db, 'norecord', 'agents', null);
  stubDial(telnyx);
}, 180_000);

beforeEach(async () => {
  await db.delete(schema.deskPhoneCallLegs);
  await db.delete(schema.voipCalls);
  realtime.published.length = 0;
  realtime.setPresence(null);
});

afterAll(() => vi.unstubAllGlobals());

describe('the hold audio', () => {
  it('serves a stable 8 kHz mono ringback tone', async () => {
    const res = await app().request(`${BASE}/ringback.wav`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('cache-control')).toContain('max-age=86400');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
    expect([text(0, 4), text(8, 12), text(12, 16), text(36, 40)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8000 * 5 * 2);
    expect(bytes.length).toBe(44 + 8000 * 5 * 2);
    // 1 s of tone, then 4 s of silence.
    const sample = (i: number) => view.getInt16(44 + i * 2, true);
    expect(Array.from({ length: 8000 }, (_, i) => Math.abs(sample(i))).some((v) => v > 5000)).toBe(true);
    expect(Array.from({ length: 32000 }, (_, i) => sample(8000 + i)).every((v) => v === 0)).toBe(true);
    const again = new Uint8Array(await (await app().request(`${BASE}/ringback.wav`)).arrayBuffer());
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe('an inbound call to an agents route', () => {
  it('answers, queues the caller with hold audio and rings every available member', async () => {
    const { control, call, calls } = await inbound('agents', '+31612340001');
    expect(call).toMatchObject({ departmentId: null, outcome: null, agentAnsweredAt: null, endedAt: null });
    expect(call.queueEnteredAt).toBeInstanceOf(Date);

    // Answer, greeting, queue, hold audio: in that order, on the caller's leg.
    const onCaller = calls.filter((c) => c.url.pathname.startsWith(`/v2/calls/${control}/actions/`)).map((c) => c.url.pathname.split('/').pop());
    expect(onCaller).toEqual(['answer', 'speak', 'enqueue', 'playback_start']);
    const [speak] = actionCalls(calls, control, 'speak');
    expect(speak!.body).toMatchObject({ payload: 'Welcome to Acme.', voice: 'female', language: 'en-US' });
    const [enqueue] = actionCalls(calls, control, 'enqueue');
    expect(enqueue!.body).toMatchObject({ queue_name: `desk-${ORG}-all`, max_wait_time_secs: 120 });
    expect(decodeState((enqueue!.body as { client_state: string }).client_state)).toMatchObject({
      callId: call.id,
      workspaceId: ORG,
      record: 'false',
      stage: 'queue',
    });
    const [hold] = actionCalls(calls, control, 'playback_start');
    expect(hold!.body).toMatchObject({
      audio_url: 'https://call-api-test.weldsuite.org/public/webhooks/telnyx/ringback.wav',
      loop: 'infinity',
    });
    // The queue's start does not record: the call is recorded once an agent has it.
    expect(actionCalls(calls, control, 'record_start')).toHaveLength(0);

    // One dial per available member, on the voice connection, to their SIP address.
    const dials = dialCalls(calls).map((c) => c.body as DialBody);
    expect(dials.map((d) => d.to).sort()).toEqual(['sip:sip_anna@sip.telnyx.com', 'sip:sip_bob@sip.telnyx.com']);
    for (const dial of dials) {
      expect(dial).toMatchObject({ connection_id: 'conn-1', from: '+31612340001', timeout_secs: 20 });
    }
    const legs = await legsOf(db, call.id);
    expect(legs.map((l) => [l.userId, l.status, l.providerCallId?.startsWith('cc-leg-')])).toEqual([
      ['user_anna', 'ringing', true],
      ['user_bob', 'ringing', true],
    ]);
    const annaDial = dials.find((d) => d.to.includes('sip_anna'))!;
    expect(decodeState(annaDial.client_state)).toEqual({ workspaceId: ORG, agentLegId: legOf(legs, 'user_anna').id, parentCallId: call.id });

    // Both browsers are told; the member who is not available is not.
    for (const user of ['user_anna', 'user_bob']) {
      const [incoming] = realtime.inbox(user, 'phone.incoming');
      expect(incoming!.data).toMatchObject({
        callId: call.id,
        conversationId: call.deskConversationId,
        fromNumber: '+31612340001',
        departmentId: null,
        waitingSince: call.queueEnteredAt!.toISOString(),
      });
    }
    expect(realtime.inbox('user_cy', 'phone.incoming')).toHaveLength(0);
    expect(realtime.queue().at(-1)!.data).toEqual({ waiting: 1 });
  });

  it('rings only members who are online, and lets the caller wait when nobody free is', async () => {
    realtime.setPresence({ user_anna: 'online' });
    const online = await inbound('agents', '+31612340002');
    expect(dialCalls(online.calls).map((c) => (c.body as DialBody).to)).toEqual(['sip:sip_anna@sip.telnyx.com']);

    // Anna is on a call now: Bob is offline, so the next caller waits with nobody ringing.
    const waiting = await inbound('agents', '+31612340003');
    expect(dialCalls(waiting.calls)).toHaveLength(0);
    expect(actionCalls(waiting.calls, waiting.control, 'enqueue')).toHaveLength(1);
    expect(await callState(waiting.call.id)).toMatchObject({ outcome: null });
    expect(await legsOf(db, waiting.call.id)).toHaveLength(0);
  });

  it('keeps busy members out of a round (a call of theirs that is not over)', async () => {
    await db.insert(schema.voipCalls).values({
      id: 'vcall_q_bobs', userId: 'user_bob', direction: 'outbound', status: 'answered', fromNumber: '+31201270001', toNumber: '+31612349999', initiatedAt: new Date(),
    });
    const { calls } = await inbound('agents', '+31612340004');
    expect(dialCalls(calls).map((c) => (c.body as DialBody).to)).toEqual(['sip:sip_anna@sip.telnyx.com']);
  });

  it('rings the members of the route’s team', async () => {
    const { call, calls } = await inbound('team', '+31612340005');
    expect(dialCalls(calls).map((c) => (c.body as DialBody).to)).toEqual(['sip:sip_bob@sip.telnyx.com']);
    expect(call.departmentId).toBe('dept_q_sales');
    const [enqueue] = actionCalls(calls, call.providerCallId!, 'enqueue');
    expect(enqueue!.body).toMatchObject({ queue_name: `desk-${ORG}-dept_q_sales`, max_wait_time_secs: 300 });
    const [incoming] = realtime.inbox('user_bob', 'phone.incoming');
    expect(incoming!.data).toMatchObject({ departmentId: 'dept_q_sales' });
  });

  it('bridges the first member who answers, hangs up the others and assigns the conversation', async () => {
    const { control, call } = await inbound('agents', '+31612340006');
    const legs = await legsOf(db, call.id);
    const anna = legOf(legs, 'user_anna');
    const bob = legOf(legs, 'user_bob');
    const mark = telnyx.calls.length;
    realtime.published.length = 0;

    await deliver(legEvent('call.answered', anna));
    const calls = telnyx.calls.slice(mark);

    expect(actionCalls(calls, anna.providerCallId!, 'bridge')[0]!.body).toEqual({ call_control_id: control });
    expect(actionCalls(calls, control, 'playback_stop')).toHaveLength(1);
    const [record] = actionCalls(calls, control, 'record_start');
    expect(record!.body).toMatchObject({ channels: 'dual', format: 'mp3' });
    expect(decodeState((record!.body as { client_state: string }).client_state)).toMatchObject({ callId: call.id, stage: 'call', record: 'false' });
    expect(actionCalls(calls, bob.providerCallId!, 'hangup')).toHaveLength(1);

    const row = await callState(call.id);
    expect(row).toMatchObject({ answeredByUserId: 'user_anna', userId: 'user_anna', outcome: 'answered' });
    expect(row.agentAnsweredAt).toBeInstanceOf(Date);
    expect((await legsOf(db, call.id)).map((l) => [l.userId, l.status])).toEqual([
      ['user_anna', 'answered'],
      ['user_bob', 'ended'],
    ]);

    const [conversation] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, call.deskConversationId!));
    expect(conversation!.assigneeId).toBe('user_anna');
    const messages = await messagesOf(db, call.deskConversationId!);
    const assigned = messages.find((m) => (m.metadata as { eventType?: string } | null)?.eventType === 'assigned');
    expect(assigned).toMatchObject({ kind: 'event', metadata: { eventType: 'assigned', assigneeId: 'user_anna', via: 'phone' } });
    const answered = messages.find((m) => (m.metadata as { event?: string } | null)?.event === 'call_answered');
    expect(answered).toMatchObject({ authorType: 'system', body: 'Call answered by Anna Agent', metadata: { callId: call.id, userId: 'user_anna' } });

    expect(realtime.inbox('user_anna', 'phone.answered')[0]!.data).toMatchObject({
      callId: call.id,
      conversationId: call.deskConversationId,
      answeredByUserId: 'user_anna',
    });
    expect(realtime.inbox('user_bob', 'phone.ended')[0]!.data).toMatchObject({ callId: call.id, reason: 'answered_elsewhere' });
    expect(realtime.inbox('user_anna', 'phone.ended')).toHaveLength(0);
    expect(realtime.queue().at(-1)!.data).toEqual({ waiting: 0 });

    // Bob's own hangup for the leg we ended finds it ended and starts nothing.
    const afterMark = telnyx.calls.length;
    await deliver(legEvent('call.hangup', bob, { hangup_cause: 'originator_cancel' }));
    expect(dialCalls(telnyx.calls.slice(afterMark))).toHaveLength(0);
  });

  it('answers a repeated or late call.answered without hanging the winner up', async () => {
    const { call } = await inbound('agents', '+31612340007');
    const legs = await legsOf(db, call.id);
    const anna = legOf(legs, 'user_anna');
    const bob = legOf(legs, 'user_bob');
    await deliver(legEvent('call.answered', anna));

    const mark = telnyx.calls.length;
    await deliver(legEvent('call.answered', anna));
    expect(actionCalls(telnyx.calls.slice(mark), anna.providerCallId!, 'hangup')).toHaveLength(0);
    expect(actionCalls(telnyx.calls.slice(mark), anna.providerCallId!, 'bridge')).toHaveLength(0);

    // Bob accepted just after losing: his leg is hung up and the call stays Anna's.
    await deliver(legEvent('call.answered', bob));
    expect(actionCalls(telnyx.calls.slice(mark), bob.providerCallId!, 'hangup')).toHaveLength(1);
    expect(await callState(call.id)).toMatchObject({ answeredByUserId: 'user_anna', outcome: 'answered' });
    expect(realtime.inbox('user_anna', 'phone.answered')).toHaveLength(1);
  });

  it('hangs the caller up when the member who answered hangs up', async () => {
    const { control, call } = await inbound('agents', '+31612340008');
    const anna = legOf(await legsOf(db, call.id), 'user_anna');
    await deliver(legEvent('call.answered', anna));
    const mark = telnyx.calls.length;
    await deliver(legEvent('call.hangup', anna));
    expect(actionCalls(telnyx.calls.slice(mark), control, 'hangup')).toHaveLength(1);
    expect((await legsOf(db, call.id)).find((l) => l.userId === 'user_anna')).toMatchObject({ status: 'ended' });
  });

  it('records the call when the number records and not when it does not', async () => {
    const quiet = await inbound('norecord', '+31612340009');
    const anna = legOf(await legsOf(db, quiet.call.id), 'user_anna');
    const mark = telnyx.calls.length;
    await deliver(legEvent('call.answered', anna));
    expect(actionCalls(telnyx.calls.slice(mark), quiet.control, 'record_start')).toHaveLength(0);
    expect(actionCalls(telnyx.calls.slice(mark), anna.providerCallId!, 'bridge')).toHaveLength(1);
  });

  it('rings again when a round rang out, but not when its legs failed at once', async () => {
    const { call } = await inbound('agents', '+31612340010');
    const [anna, bob] = (await legsOf(db, call.id)) as [Leg, Leg];

    // Both legs hang up immediately (a broken credential): no new round.
    let mark = telnyx.calls.length;
    await deliver(legEvent('call.hangup', anna, { hangup_cause: 'unallocated_number' }));
    await deliver(legEvent('call.hangup', bob, { hangup_cause: 'unallocated_number' }));
    expect(dialCalls(telnyx.calls.slice(mark))).toHaveLength(0);

    // A round that rang for 25 s: the next round starts when the last leg ends, not before.
    const second = await inbound('agents', '+31612340011');
    const [a2, b2] = (await legsOf(db, second.call.id)) as [Leg, Leg];
    await backdate(second.call.id, 25_000);
    mark = telnyx.calls.length;
    await deliver(legEvent('call.hangup', a2, { hangup_cause: 'timeout' }));
    expect(dialCalls(telnyx.calls.slice(mark))).toHaveLength(0);
    await deliver(legEvent('call.hangup', b2, { hangup_cause: 'timeout' }));
    const redial = dialCalls(telnyx.calls.slice(mark));
    expect(redial.map((c) => (c.body as DialBody).to).sort()).toEqual(['sip:sip_anna@sip.telnyx.com', 'sip:sip_bob@sip.telnyx.com']);
    expect((await legsOf(db, second.call.id)).filter((l) => l.status === 'ringing')).toHaveLength(2);
    expect((await legsOf(db, second.call.id))).toHaveLength(4);

    // A repeated hangup of an ended leg does not start another round.
    mark = telnyx.calls.length;
    await deliver(legEvent('call.hangup', b2, { hangup_cause: 'timeout' }));
    expect(dialCalls(telnyx.calls.slice(mark))).toHaveLength(0);
  });

  it('offers the oldest waiting caller to an agent who finishes a call', async () => {
    realtime.setPresence({ user_anna: 'online' });
    const first = await inbound('agents', '+31612340020');
    const anna = legOf(await legsOf(db, first.call.id), 'user_anna');
    await deliver(legEvent('call.answered', anna));
    // Anna is busy and Bob is offline: the next caller waits with nobody ringing.
    const second = await inbound('agents', '+31612340021');
    expect(dialCalls(second.calls)).toHaveLength(0);

    const mark = telnyx.calls.length;
    await deliver(legEvent('call.hangup', anna));
    const dials = dialCalls(telnyx.calls.slice(mark));
    expect(dials.map((c) => (c.body as DialBody).to)).toEqual(['sip:sip_anna@sip.telnyx.com']);
    expect(decodeState((dials[0]!.body as DialBody).client_state).parentCallId).toBe(second.call.id);
    expect(dials[0]!.body).toMatchObject({ from: '+31612340021' });
    expect(realtime.inbox('user_anna', 'phone.incoming').at(-1)!.data).toMatchObject({ callId: second.call.id });
  });

  it('puts the caller back in the queue when the bridge fails', async () => {
    const { control, call } = await inbound('agents', '+31612340022');
    const legs = await legsOf(db, call.id);
    const anna = legOf(legs, 'user_anna');
    const bob = legOf(legs, 'user_bob');
    telnyx.on('POST', `/calls/${anna.providerCallId}/actions/bridge`, () => telnyxError(422, 'call gone'));
    const mark = telnyx.calls.length;
    realtime.published.length = 0;

    await deliver(legEvent('call.answered', anna));
    const calls = telnyx.calls.slice(mark);

    expect(await callState(call.id)).toMatchObject({ outcome: null, agentAnsweredAt: null, answeredByUserId: null, userId: 'system', endedAt: null });
    expect((await legsOf(db, call.id)).map((l) => [l.userId, l.status])).toEqual([
      ['user_anna', 'ended'],
      ['user_bob', 'ringing'],
    ]);
    expect(actionCalls(calls, anna.providerCallId!, 'hangup')).toHaveLength(1);
    expect(actionCalls(calls, bob.providerCallId!, 'hangup')).toHaveLength(0);
    expect(actionCalls(calls, control, 'record_start')).toHaveLength(0);
    expect(dialCalls(calls)).toHaveLength(0);
    const [conversation] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, call.deskConversationId!));
    expect(conversation!.assigneeId).toBeNull();
    expect((await messagesOf(db, call.deskConversationId!)).map((m) => m.body)).not.toContain('Call answered by Anna Agent');
    expect(realtime.inbox('user_anna', 'phone.answered')).toHaveLength(0);
    expect(realtime.inbox('user_anna', 'phone.ended')[0]!.data).toMatchObject({ callId: call.id, reason: 'timeout' });
    expect(realtime.inbox('user_bob', 'phone.ended')).toHaveLength(0);
    expect(realtime.queue().at(-1)!.data).toEqual({ waiting: 1 });
    const waiting = await db.select({ id: schema.voipCalls.id }).from(schema.voipCalls).where(waitingCallsCondition());
    expect(waiting.map((r) => r.id)).toEqual([call.id]);

    // Bob, still ringing, can answer it.
    await deliver(legEvent('call.answered', bob));
    expect(await callState(call.id)).toMatchObject({ outcome: 'answered', answeredByUserId: 'user_bob', userId: 'user_bob' });
    expect(actionCalls(telnyx.calls.slice(mark), bob.providerCallId!, 'bridge')).toHaveLength(1);
  });

  it('never dials more than 40 legs for one call', async () => {
    const { call } = await inbound('agents', '+31612340012');
    const rows = Array.from({ length: 37 }, (_, i) => ({
      id: `dleg_q_cap_${i}`, callId: call.id, userId: 'user_cy', status: 'ended' as const,
    }));
    await db.insert(schema.deskPhoneCallLegs).values(rows);
    const [anna, bob] = (await legsOf(db, call.id)).filter((l) => l.status === 'ringing') as [Leg, Leg];
    await backdate(call.id, 25_000);
    const mark = telnyx.calls.length;
    await deliver(legEvent('call.hangup', anna, { hangup_cause: 'timeout' }));
    await deliver(legEvent('call.hangup', bob, { hangup_cause: 'timeout' }));
    // 37 + 2 legs so far: one more fits.
    expect(dialCalls(telnyx.calls.slice(mark))).toHaveLength(1);
  });

  it('marks a leg ended when its dial fails and rings the rest', async () => {
    stubDial(telnyx, (to) => to.includes('sip_bob'));
    const { call, calls } = await inbound('agents', '+31612340013');
    expect(dialCalls(calls)).toHaveLength(2);
    expect((await legsOf(db, call.id)).map((l) => [l.userId, l.status])).toEqual([
      ['user_anna', 'ringing'],
      ['user_bob', 'ended'],
    ]);
    expect(realtime.inbox('user_bob', 'phone.incoming')).toHaveLength(0);
    expect(realtime.inbox('user_anna', 'phone.incoming')).toHaveLength(1);
    stubDial(telnyx);
  });

  it('marks the call abandoned when the caller hangs up while waiting', async () => {
    const { control, call } = await inbound('agents', '+31612340014');
    const legs = await legsOf(db, call.id);
    const mark = telnyx.calls.length;
    realtime.published.length = 0;

    const hangup = callEvent('call.hangup', {
      client_state: encodeState({ callId: call.id, workspaceId: ORG, deskConversationId: call.deskConversationId! }),
      call_control_id: control,
      hangup_cause: 'originator_cancel',
    });
    await deliver(hangup);

    const row = await callState(call.id);
    expect(row).toMatchObject({ outcome: 'abandoned', status: 'canceled' });
    expect(row.endedAt).toBeInstanceOf(Date);
    for (const leg of legs) expect(actionCalls(telnyx.calls.slice(mark), leg.providerCallId!, 'hangup')).toHaveLength(1);
    expect((await legsOf(db, call.id)).every((l) => l.status === 'ended')).toBe(true);
    for (const user of ['user_anna', 'user_bob']) {
      expect(realtime.inbox(user, 'phone.ended')[0]!.data).toMatchObject({ callId: call.id, reason: 'caller_hung_up' });
    }
    expect(realtime.queue().at(-1)!.data).toEqual({ waiting: 0 });

    // A repeated hangup changes nothing.
    realtime.published.length = 0;
    await deliver(hangup);
    expect(realtime.inbox('user_anna', 'phone.ended')).toHaveLength(0);
  });

  it('does not call a call abandoned once an agent has it', async () => {
    const { control, call } = await inbound('agents', '+31612340015');
    await deliver(legEvent('call.answered', legOf(await legsOf(db, call.id), 'user_anna')));
    await deliver(
      callEvent('call.hangup', {
        client_state: encodeState({ callId: call.id, workspaceId: ORG }),
        call_control_id: control,
        hangup_cause: 'normal_clearing',
      }),
    );
    expect(await callState(call.id)).toMatchObject({ outcome: 'answered' });
    // The conversation comes from the call row, as for any call whose client_state has none.
    expect((await messagesOf(db, call.deskConversationId!)).map((m) => m.body)).toContain('Call ended (completed)');
  });

  it('hangs up with a missed-call note when nobody answers and the route says hang up', async () => {
    const { control, call } = await inbound('hangup', '+31612340016');
    const legs = await legsOf(db, call.id);
    const mark = telnyx.calls.length;
    realtime.published.length = 0;
    const dequeued = callEvent('call.dequeued', {
      client_state: encodeState({ callId: call.id, workspaceId: ORG, deskConversationId: call.deskConversationId!, record: 'false', stage: 'queue' }),
      call_control_id: control,
      queue: `desk-${ORG}-all`,
      reason: 'timeout',
    });

    // Other reasons need no action.
    await deliver(callEvent('call.dequeued', { ...dequeued.data.payload, reason: 'bridged' }));
    expect(await callState(call.id)).toMatchObject({ outcome: null });

    await deliver(dequeued);
    expect(await callState(call.id)).toMatchObject({ outcome: 'missed' });
    const calls = telnyx.calls.slice(mark);
    expect(actionCalls(calls, control, 'hangup')).toHaveLength(1);
    for (const leg of legs) expect(actionCalls(calls, leg.providerCallId!, 'hangup')).toHaveLength(1);
    expect((await messagesOf(db, call.deskConversationId!)).map((m) => m.body)).toContain('Missed call');
    for (const user of ['user_anna', 'user_bob']) {
      expect(realtime.inbox(user, 'phone.ended')[0]!.data).toMatchObject({ callId: call.id, reason: 'timeout' });
    }
    expect(realtime.queue().at(-1)!.data).toEqual({ waiting: 0 });

    // A repeated timeout does it only once.
    await deliver(dequeued);
    expect(actionCalls(telnyx.calls.slice(mark), control, 'hangup')).toHaveLength(1);
  });

  it('goes straight to voicemail when nobody is staffed, without queueing', async () => {
    const { control, call, calls } = await inbound('empty', '+31612340017');
    expect(actionCalls(calls, control, 'enqueue')).toHaveLength(0);
    expect(dialCalls(calls)).toHaveLength(0);
    expect(await callState(call.id)).toMatchObject({ outcome: 'missed', departmentId: 'dept_q_empty' });
    const [speak] = actionCalls(calls, control, 'speak');
    expect(speak!.body).toMatchObject({ payload: 'Laat na de piep een bericht achter.', voice: 'female', language: 'nl-NL' });
    expect(decodeState((speak!.body as { client_state: string }).client_state)).toMatchObject({ stage: 'voicemail_greeting' });
  });
});
