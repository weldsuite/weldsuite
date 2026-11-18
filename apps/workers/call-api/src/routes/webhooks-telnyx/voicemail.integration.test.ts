/**
 * Voicemail on pglite: as a route of its own and as what an unanswered queue
 * falls back to. The caller hears the greeting, a beep and a recording starts
 * when the greeting has played; the saved recording ends the call with the
 * outcome `voicemail` and a message the inbox renders as a voicemail.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { stubTelnyx } from '../../test/telnyx-stub';
import {
  BASE,
  NUMBERS,
  ORG,
  actionCalls,
  callEvent,
  callOf,
  decodeState,
  deliverWith,
  encodeState,
  env,
  messagesOf,
  realtimeStub,
  seedPhoneWorkspace,
  setRoute,
  stubCallActions,
  stubDial,
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
async function inbound(kind: keyof typeof NUMBERS, from: string) {
  controlSeq += 1;
  const control = `cc-vm-${controlSeq}`;
  stubCallActions(telnyx, control);
  const mark = telnyx.calls.length;
  await deliver(
    callEvent('call.initiated', { direction: 'incoming', call_control_id: control, to: NUMBERS[kind], from, call_session_id: 'sess', call_leg_id: 'leg' }),
  );
  return { control, call: await callOf(db, control), calls: telnyx.calls.slice(mark) };
}

type CallRow = Awaited<ReturnType<typeof callOf>>;
const stateOf = (call: CallRow, stage: string) =>
  encodeState({ callId: call.id, workspaceId: ORG, deskConversationId: call.deskConversationId!, record: 'false', stage });
const row = async (id: string) => (await db.select().from(schema.voipCalls).where(eq(schema.voipCalls.id, id)))[0]!;
const bodies = async (call: CallRow) => (await messagesOf(db, call.deskConversationId!)).map((m) => m.body);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const master = (await createMasterPgliteDb()).db;
  holder.master = master;
  holder.tenant = db;
  await seedPhoneWorkspace(db, master);
  await setRoute(db, 'voicemail', 'voicemail', { voicemailGreeting: 'Leave a note after the beep.', language: 'en-GB' });
  await setRoute(db, 'dutch', 'voicemail', { language: 'nl-NL' });
  await setRoute(db, 'agents', 'agents', null);
  await setRoute(db, 'empty', 'voicemail', null);
  stubDial(telnyx);
}, 180_000);

beforeEach(async () => {
  await db.delete(schema.deskPhoneCallLegs);
  await db.delete(schema.voipCalls);
  realtime.published.length = 0;
});

afterAll(() => vi.unstubAllGlobals());

describe('a voicemail route', () => {
  it('answers, counts the call missed and speaks the greeting', async () => {
    const { control, call, calls } = await inbound('voicemail', '+31612341001');
    expect(calls.map((c) => c.url.pathname.split('/').pop())).toEqual(['answer', 'speak']);
    const [speak] = actionCalls(calls, control, 'speak');
    expect(speak!.body).toMatchObject({ payload: 'Leave a note after the beep.', voice: 'female', language: 'en-GB' });
    expect(decodeState((speak!.body as { client_state: string }).client_state)).toMatchObject({
      callId: call.id,
      workspaceId: ORG,
      record: 'false',
      stage: 'voicemail_greeting',
    });
    // Never offered to the team: not queued, no agent legs.
    expect(await row(call.id)).toMatchObject({ outcome: 'missed', queueEnteredAt: null });
    expect(actionCalls(calls, control, 'record_start')).toHaveLength(0);
  });

  it('speaks the default greeting in the route’s language', async () => {
    const english = await inbound('empty', '+31612341002');
    expect(actionCalls(english.calls, english.control, 'speak')[0]!.body).toMatchObject({
      payload: 'Please leave a message after the tone.',
      language: 'en-US',
    });
    const dutch = await inbound('dutch', '+31612341003');
    expect(actionCalls(dutch.calls, dutch.control, 'speak')[0]!.body).toMatchObject({
      payload: 'Laat na de piep een bericht achter.',
      language: 'nl-NL',
    });
  });

  it('starts the recording when the greeting has played, and only then', async () => {
    const { control, call } = await inbound('voicemail', '+31612341004');
    const mark = telnyx.calls.length;
    // Some other speak that ended on this call is not the greeting.
    await deliver(callEvent('call.speak.ended', { client_state: stateOf(call, 'queue'), call_control_id: control }));
    expect(actionCalls(telnyx.calls.slice(mark), control, 'record_start')).toHaveLength(0);

    await deliver(callEvent('call.speak.ended', { client_state: stateOf(call, 'voicemail_greeting'), call_control_id: control }));
    const [record] = actionCalls(telnyx.calls.slice(mark), control, 'record_start');
    expect(record!.body).toMatchObject({ channels: 'single', format: 'mp3', play_beep: true, max_length: 180 });
    expect(decodeState((record!.body as { client_state: string }).client_state)).toMatchObject({ callId: call.id, stage: 'voicemail' });
  });

  it('keeps the saved message as the call’s voicemail and hangs up', async () => {
    const { control, call } = await inbound('voicemail', '+31612341005');
    const mark = telnyx.calls.length;
    const saved = callEvent('call.recording.saved', {
      client_state: stateOf(call, 'voicemail'),
      call_control_id: control,
      recording_id: 'rec-vm-1',
      duration_secs: 23.4,
      recording_urls: { mp3: 'https://telnyx.test/vm.mp3' },
    });
    await deliver(saved);

    expect(await row(call.id)).toMatchObject({
      outcome: 'voicemail',
      isRecorded: true,
      recordingStorageUrl: 'https://telnyx.test/vm.mp3',
      recordingStorageKey: 'rec-vm-1',
      recordingDuration: 23,
    });
    const messages = await messagesOf(db, call.deskConversationId!);
    const voicemail = messages.filter((m) => (m.metadata as { event?: string } | null)?.event === 'voicemail');
    expect(voicemail).toHaveLength(1);
    expect(voicemail[0]).toMatchObject({
      authorType: 'system',
      metadata: { event: 'voicemail', callId: call.id, recordingUrl: 'https://telnyx.test/vm.mp3', duration: 23 },
    });
    // A voicemail is not a call recording.
    expect(messages.map((m) => m.body)).not.toContain('Call recording available');
    expect(actionCalls(telnyx.calls.slice(mark), control, 'hangup')).toHaveLength(1);

    // Telnyx retries: one message still.
    await deliver(saved);
    const again = (await messagesOf(db, call.deskConversationId!)).filter((m) => (m.metadata as { event?: string } | null)?.event === 'voicemail');
    expect(again).toHaveLength(1);
  });

  it('leaves the outcome missed when the caller hangs up during the greeting', async () => {
    const { control, call } = await inbound('voicemail', '+31612341006');
    await deliver(
      callEvent('call.hangup', { client_state: stateOf(call, 'voicemail_greeting'), call_control_id: control, hangup_cause: 'originator_cancel' }),
    );
    expect(await row(call.id)).toMatchObject({ outcome: 'missed', status: 'canceled' });
  });
});

describe('a queue nobody answers', () => {
  it('falls back to voicemail and ends as a voicemail', async () => {
    const { control, call } = await inbound('agents', '+31612341007');
    expect(await row(call.id)).toMatchObject({ outcome: null });
    const mark = telnyx.calls.length;

    await deliver(
      callEvent('call.dequeued', { client_state: stateOf(call, 'queue'), call_control_id: control, queue: `desk-${ORG}-all`, reason: 'timeout' }),
    );
    expect(await row(call.id)).toMatchObject({ outcome: 'missed' });
    const afterTimeout = telnyx.calls.slice(mark);
    expect(afterTimeout.filter((c) => c.url.pathname.startsWith(`/v2/calls/${control}/`)).map((c) => c.url.pathname.split('/').pop())).toEqual([
      'playback_stop',
      'speak',
    ]);
    expect(decodeState((actionCalls(afterTimeout, control, 'speak')[0]!.body as { client_state: string }).client_state)).toMatchObject({
      stage: 'voicemail_greeting',
    });

    await deliver(callEvent('call.speak.ended', { client_state: stateOf(call, 'voicemail_greeting'), call_control_id: control }));
    expect(actionCalls(telnyx.calls.slice(mark), control, 'record_start')).toHaveLength(1);

    await deliver(
      callEvent('call.recording.saved', {
        client_state: stateOf(call, 'voicemail'),
        call_control_id: control,
        duration_secs: 8,
        recording_urls: { mp3: 'https://telnyx.test/queue.mp3' },
      }),
    );
    expect(await row(call.id)).toMatchObject({ outcome: 'voicemail', recordingStorageUrl: 'https://telnyx.test/queue.mp3' });
    expect(await bodies(call)).toContain('Voicemail (8s)');
    expect(realtime.queue().at(-1)!.data).toEqual({ waiting: 0 });
  });
});
