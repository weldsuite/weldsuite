/**
 * The keypad menu route on pglite: the caller is answered once and hears the
 * prompt; the digit they press runs the matching choice (a team queue, the AI
 * voice agent, a forward or voicemail) without answering the call again; a key
 * that is not on the menu, or none, runs the fallback choice or hangs up.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { eq } from 'drizzle-orm';
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
  dialCalls,
  encodeState,
  env,
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

const PROMPT = 'Press 1 for sales, 2 for the front desk, 3 to leave a message, 4 for the mobile line.';

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
  const control = `cc-menu-${controlSeq}`;
  stubCallActions(telnyx, control);
  const mark = telnyx.calls.length;
  await deliver(
    callEvent('call.initiated', { direction: 'incoming', call_control_id: control, to: NUMBERS[kind], from, call_session_id: 'sess', call_leg_id: 'leg' }),
  );
  return { control, call: await callOf(db, control), calls: telnyx.calls.slice(mark) };
}

type CallRow = Awaited<ReturnType<typeof callOf>>;
/** `call.gather.ended` for the menu prompt of `call`. */
const gather = (call: CallRow, payload: { digits?: string; status: string }, stage = 'menu') =>
  callEvent('call.gather.ended', {
    client_state: encodeState({ callId: call.id, workspaceId: ORG, deskConversationId: call.deskConversationId!, record: 'false', stage }),
    call_control_id: call.providerCallId,
    ...payload,
  });
const row = async (id: string) => (await db.select().from(schema.voipCalls).where(eq(schema.voipCalls.id, id)))[0]!;
const choiceMessage = async (call: CallRow) =>
  (await messagesOf(db, call.deskConversationId!)).filter((m) => (m.metadata as { event?: string } | null)?.event === 'menu_choice');
const bodies = async (call: CallRow) => (await messagesOf(db, call.deskConversationId!)).map((m) => m.body);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const master = (await createMasterPgliteDb()).db;
  holder.master = master;
  holder.tenant = db;
  await seedPhoneWorkspace(db, master);
  await setRoute(db, 'menu', 'menu', {
    language: 'en-US',
    menu: {
      prompt: PROMPT,
      choices: [
        { digit: '1', label: 'Sales', action: 'agents', departmentId: 'dept_q_sales' },
        { digit: '2', label: 'Front desk', action: 'ai_agent', voiceAgentId: 'dva_q_front' },
        { digit: '3', action: 'voicemail' },
        { digit: '4', label: 'Mobile', action: 'forward', forwardToE164: '+31612349000' },
      ],
      fallbackDigit: '3',
    },
  });
  // The same menu with no fallback.
  await setRoute(db, 'hangup', 'menu', {
    language: 'nl-NL',
    menu: { prompt: 'Druk 1 voor verkoop.', choices: [{ digit: '1', action: 'voicemail' }] },
  });
  stubDial(telnyx);
}, 180_000);

beforeEach(async () => {
  await db.delete(schema.deskPhoneCallLegs);
  await db.delete(schema.voipCalls);
});

afterAll(() => vi.unstubAllGlobals());

describe('the menu', () => {
  it('answers once and speaks the prompt, collecting one digit', async () => {
    const { control, call, calls } = await inbound('menu', '+31612342001');
    expect(calls.map((c) => c.url.pathname.split('/').pop())).toEqual(['answer', 'gather_using_speak']);
    const [prompt] = actionCalls(calls, control, 'gather_using_speak');
    expect(prompt!.body).toMatchObject({
      payload: PROMPT,
      voice: 'female',
      language: 'en-US',
      minimum_digits: 1,
      maximum_digits: 1,
      maximum_tries: 2,
      timeout_millis: 8000,
      valid_digits: '1234',
    });
    expect(decodeState((prompt!.body as { client_state: string }).client_state)).toMatchObject({
      callId: call.id,
      workspaceId: ORG,
      record: 'false',
      stage: 'menu',
    });
    // The call is not offered to anyone yet.
    expect(await row(call.id)).toMatchObject({ queueEnteredAt: null, outcome: null });
  });

  it('sends a caller who presses 1 to the team’s queue', async () => {
    const { control, call } = await inbound('menu', '+31612342002');
    const mark = telnyx.calls.length;
    await deliver(gather(call, { digits: '1', status: 'valid' }));
    const calls = telnyx.calls.slice(mark);

    expect(await bodies(call)).toContain('Caller chose 1 (Sales)');
    const [chosen] = await choiceMessage(call);
    expect(chosen!.metadata).toMatchObject({ event: 'menu_choice', digit: '1', label: 'Sales', action: 'agents' });
    expect(actionCalls(calls, control, 'answer')).toHaveLength(0);
    expect(actionCalls(calls, control, 'enqueue')[0]!.body).toMatchObject({ queue_name: `desk-${ORG}-dept_q_sales`, max_wait_time_secs: 300 });
    expect(await row(call.id)).toMatchObject({ departmentId: 'dept_q_sales' });
    expect(dialCalls(calls).map((c) => (c.body as DialBody).to)).toEqual(['sip:sip_bob@sip.telnyx.com']);
  });

  it('hands a caller who presses 2 to the AI voice agent without answering again', async () => {
    const { control, call, calls: start } = await inbound('menu', '+31612342003');
    const mark = telnyx.calls.length;
    await deliver(gather(call, { digits: '2', status: 'valid' }));
    const calls = telnyx.calls.slice(mark);

    // The menu answered the call once; the AI flow adds no second answer.
    expect(actionCalls(start, control, 'answer')).toHaveLength(1);
    expect(actionCalls(calls, control, 'answer')).toHaveLength(0);
    const [aiStart] = actionCalls(calls, control, 'ai_assistant_start');
    expect(aiStart!.body).toMatchObject({ assistant: { id: 'asst-q-front' } });
    expect(decodeState((aiStart!.body as { client_state: string }).client_state)).toMatchObject({
      callId: call.id,
      voiceAgentId: 'dva_q_front',
      record: 'false',
    });
    expect(actionCalls(calls, control, 'record_start')).toHaveLength(1);
    expect(await bodies(call)).toEqual(expect.arrayContaining(['Caller chose 2 (Front desk)', 'AI agent “Front desk” answered the call']));
  });

  it('records a voicemail for a caller who presses 3', async () => {
    const { control, call } = await inbound('menu', '+31612342004');
    const mark = telnyx.calls.length;
    await deliver(gather(call, { digits: '3', status: 'valid' }));
    const calls = telnyx.calls.slice(mark);
    expect(actionCalls(calls, control, 'answer')).toHaveLength(0);
    expect(actionCalls(calls, control, 'speak')[0]!.body).toMatchObject({ payload: 'Please leave a message after the tone.' });
    expect(await row(call.id)).toMatchObject({ outcome: 'missed' });
    // No label: no parentheses.
    expect(await bodies(call)).toContain('Caller chose 3');
  });

  it('forwards a caller who presses 4', async () => {
    const { control, call } = await inbound('menu', '+31612342005');
    const mark = telnyx.calls.length;
    await deliver(gather(call, { digits: '4', status: 'valid' }));
    const [transfer] = actionCalls(telnyx.calls.slice(mark), control, 'transfer');
    expect(transfer!.body).toMatchObject({ to: '+31612349000', from: NUMBERS.menu });
    expect(await bodies(call)).toEqual(expect.arrayContaining(['Caller chose 4 (Mobile)', 'Forwarding call to +31612349000']));
  });

  it('runs the fallback choice for a wrong key, no key, or a key off the menu', async () => {
    for (const [index, payload] of [
      { digits: '7', status: 'invalid' },
      { status: 'timeout' },
      { digits: '9', status: 'valid' },
    ].entries()) {
      const { control, call } = await inbound('menu', `+3161234210${index}`);
      const mark = telnyx.calls.length;
      await deliver(gather(call, payload));
      expect(actionCalls(telnyx.calls.slice(mark), control, 'speak')).toHaveLength(1);
      expect(await bodies(call)).toContain('No valid choice, continuing with 3');
      const [chosen] = await choiceMessage(call);
      expect(chosen!.metadata).toMatchObject({ digit: '3', action: 'voicemail', fallback: true });
    }
  });

  it('hangs up with a note when there is no fallback', async () => {
    const { control, call } = await inbound('hangup', '+31612342201');
    const [prompt] = actionCalls(telnyx.calls, control, 'gather_using_speak');
    expect(prompt!.body).toMatchObject({ payload: 'Druk 1 voor verkoop.', language: 'nl-NL', valid_digits: '1' });
    const mark = telnyx.calls.length;
    await deliver(gather(call, { status: 'timeout' }));
    expect(actionCalls(telnyx.calls.slice(mark), control, 'hangup')).toHaveLength(1);
    expect(await bodies(call)).toContain('Caller made no menu choice');
  });

  it('does nothing when the caller hung up, or for a gather that is not the menu', async () => {
    const { call } = await inbound('menu', '+31612342301');
    const mark = telnyx.calls.length;
    await deliver(gather(call, { status: 'call_hangup' }));
    await deliver(gather(call, { status: 'cancelled' }));
    await deliver(gather(call, { digits: '1', status: 'valid' }, 'queue'));
    expect(telnyx.calls.slice(mark)).toHaveLength(0);
    expect(await choiceMessage(call)).toHaveLength(0);
  });

  it('runs a choice once when Telnyx delivers the event twice', async () => {
    const { control, call } = await inbound('menu', '+31612342401');
    const event = gather(call, { digits: '1', status: 'valid' });
    await deliver(event);
    const mark = telnyx.calls.length;
    await deliver(event);
    expect(telnyx.calls.slice(mark)).toHaveLength(0);
    expect(await choiceMessage(call)).toHaveLength(1);
    expect(actionCalls(telnyx.calls, control, 'enqueue')).toHaveLength(1);
  });
});
