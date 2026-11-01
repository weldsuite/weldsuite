/**
 * /public/webhooks/telnyx on pglite: the Ed25519 signature, porting events
 * (through the master porting index), an inbound call routed by its number
 * (the master registry, the CRM caller match, the WeldDesk phone
 * conversation, then forward, voice agent or hang-up), the call's later
 * events (status, recording, AI summary, live transcript, the minutes
 * settled from the wallet) and the voice agent's `lookup_crm` tool. Telnyx
 * is a fetch stub answering by URL; the master and tenant databases are
 * pglite, shared with the Rust server in conformance mode (every workspace
 * opens the test's tenant database).
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { signDeskPhoneToolToken } from '../../lib/desk-phone-tool-auth';
import { json, stubTelnyx, telnyxError, type TelnyxCall } from '../../test/telnyx-stub';

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

const BASE = '/public/webhooks/telnyx';
const ORG = 'org_hook';
const API_KEY = 'telnyx-key';

const keys = generateKeyPairSync('ed25519');
const PUBLIC_KEY = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const telnyx = stubTelnyx();

function app(env: Record<string, unknown> = {}) {
  return createTestApp(BASE, telnyxWebhookRoutes, {
    context: { tenantDb: db, masterDb: master, orgId: null, clerkOrgId: null },
    env: { TELNYX_PUBLIC_KEY: PUBLIC_KEY, TELNYX_API_KEY: API_KEY, TELNYX_CONNECTION_ID: 'conn-1', ...env } as never,
  });
}

function signed(raw: string, stamp = String(Math.floor(Date.now() / 1000))) {
  return {
    'Content-Type': 'application/json',
    'telnyx-timestamp': stamp,
    'telnyx-signature-ed25519': sign(null, Buffer.from(`${stamp}|${raw}`), keys.privateKey).toString('base64'),
  };
}

function deliver(event: unknown, env: Record<string, unknown> = {}) {
  const raw = typeof event === 'string' ? event : JSON.stringify(event);
  return app(env).request(BASE, { method: 'POST', headers: signed(raw), body: raw });
}

const encodeState = (state: Record<string, string>) => btoa(JSON.stringify(state));

function callEvent(eventType: string, payload: Record<string, unknown>, occurredAt = '2026-10-10T10:00:00Z') {
  return { data: { event_type: eventType, id: `ev-${eventType}`, occurred_at: occurredAt, payload, record_type: 'event' }, meta: { attempt: 1 } };
}

const actionCalls = (calls: TelnyxCall[], control: string, action: string) =>
  calls.filter((c) => c.method === 'POST' && c.url.pathname === `/v2/calls/${control}/actions/${action}`);

async function messagesOf(conversationId: string) {
  return db.select().from(schema.deskMessages).where(eq(schema.deskMessages.conversationId, conversationId)).orderBy(schema.deskMessages.createdAt);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  holder.tenant = db;
  await master.insert(masterSchema.workspaces).values({ id: 'ws_hook', clerkOrgId: ORG, name: 'Hook', slug: 'hook' } as typeof masterSchema.workspaces.$inferInsert);
  const now = new Date();
  await master.insert(masterSchema.workspaceCredits).values({ id: 'wcr_hook', workspaceId: 'ws_hook', currentBalance: 10, periodStart: now, periodEnd: now });
  await db.insert(schema.voipPhoneNumbers).values([
    { id: 'vpn_hook_forward', provider: 'telnyx', phoneNumber: '+31201250001', countryCode: 'NL', status: 'active', assignedUserId: 'user_agent' },
    { id: 'vpn_hook_ai', provider: 'telnyx', phoneNumber: '+31201250002', countryCode: 'NL', status: 'active' },
    { id: 'vpn_hook_none', provider: 'telnyx', phoneNumber: '+31201250003', countryCode: 'NL', status: 'active', enableRecording: false },
    { id: 'vpn_hook_closed', provider: 'telnyx', phoneNumber: '+31201250004', countryCode: 'NL', status: 'active', allowInbound: false },
    { id: 'vpn_hook_off', provider: 'telnyx', phoneNumber: '+31201250005', countryCode: 'NL', status: 'active' },
    { id: 'vpn_hook_broken', provider: 'telnyx', phoneNumber: '+31201250006', countryCode: 'NL', status: 'active' },
  ]);
  await master.insert(masterSchema.phoneNumberRegistry).values(
    ['forward', 'ai', 'none', 'closed', 'off', 'broken'].map((kind, index) => ({
      phoneNumber: `+3120125000${index + 1}`,
      clerkOrgId: ORG,
      voipPhoneNumberId: `vpn_hook_${kind}`,
    })),
  );
  await db.insert(schema.deskVoiceAgents).values([
    { id: 'dva_hook', name: 'Front desk', systemPrompt: '  Be kind.  ', telnyxAssistantId: 'asst-hook', forwardToE164: '+31612350099' },
    { id: 'dva_hook_off', name: 'Off', systemPrompt: 'x', telnyxAssistantId: 'asst-off', enabled: false },
  ]);
  await db.insert(schema.deskPhoneRoutes).values([
    { id: 'dpr_hook_forward', voipPhoneNumberId: 'vpn_hook_forward', action: 'forward', forwardToE164: '+31612350100' },
    { id: 'dpr_hook_ai', voipPhoneNumberId: 'vpn_hook_ai', action: 'ai_agent', voiceAgentId: 'dva_hook' },
    { id: 'dpr_hook_off', voipPhoneNumberId: 'vpn_hook_off', action: 'ai_agent', voiceAgentId: 'dva_hook_off' },
    { id: 'dpr_hook_broken', voipPhoneNumberId: 'vpn_hook_broken', action: 'forward', forwardToE164: '+31612350666' },
  ]);
  await db.insert(schema.people).values({
    id: 'per_hook_anna', displayName: 'Anna Caller', email: 'anna@example.test', mobilePhone: '06 1235 0001',
  } as typeof schema.people.$inferInsert);
  await db.insert(schema.companies).values({
    id: 'cmp_hook_acme', name: 'Acme', displayName: 'Acme BV', phone: '+31 20 999 0000', email: 'info@acme.test',
  } as typeof schema.companies.$inferInsert);
  await db.insert(schema.crmLeads).values({
    id: 'lead_hook_bob', firstName: 'Bob', lastName: 'Lead', email: 'bob@lead.test', companyName: 'Leadco', phone: '06-1235-0002',
  } as typeof schema.crmLeads.$inferInsert);
  for (const action of ['answer', 'hangup', 'transfer', 'ai_assistant_start', 'record_start']) {
    telnyx.on('POST', `/calls/cc-inbound-1/actions/${action}`, { data: { result: 'ok' } });
  }
}, 180_000);

afterAll(() => vi.unstubAllGlobals());

describe('the receiver', () => {
  it('answers a health check', async () => {
    const res = await app().request(BASE);
    expect(await res.json()).toEqual({ status: 'ok', service: 'telnyx-webhook' });
  });

  it('refuses what Telnyx did not sign', async () => {
    const raw = JSON.stringify(callEvent('call.bridged', {}));
    const refused = { error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } };
    const noKey = await app({ TELNYX_PUBLIC_KEY: undefined }).request(BASE, { method: 'POST', headers: signed(raw), body: raw });
    expect(noKey.status).toBe(401);
    expect(await noKey.json()).toEqual(refused);
    const unsigned = await app().request(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
    expect(unsigned.status).toBe(401);
    const tampered = await app().request(BASE, { method: 'POST', headers: signed(raw), body: `${raw} ` });
    expect(tampered.status).toBe(401);
    const stale = String(Math.floor(Date.now() / 1000) - 600);
    expect((await app().request(BASE, { method: 'POST', headers: signed(raw, stale), body: raw })).status).toBe(401);
  });

  it('answers 400 for a body that is not JSON and 500 for one without data', async () => {
    const bad = await deliver('not json');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } });
    const empty = await deliver({ meta: {} });
    expect(empty.status).toBe(500);
    expect(await empty.json()).toEqual({ error: 'Webhook processing failed' });
  });

  it('acknowledges events it has nothing to do with', async () => {
    expect(await (await deliver(callEvent('call.hangup', { call_control_id: 'cc-x' }))).json()).toEqual({ ok: true });
    expect(await (await deliver(callEvent('call.initiated', { direction: 'outgoing' }))).json()).toEqual({ ok: true });
  });
});

describe('porting events', () => {
  const porting = (status: string, payload: Record<string, unknown> = {}) =>
    deliver({ data: { event_type: 'porting.order.status_changed', id: 'ev-port', occurred_at: '', payload: { status, ...payload }, record_type: 'event' } });

  beforeAll(async () => {
    const order = (id: string, phone: string) => ({
      id,
      createdByUserId: 'user_porter',
      phoneNumber: phone,
      formattedNumber: phone.replace('+31', '0'),
      countryCode: 'NL',
      numberType: 'local',
      status: 'submitted',
      telnyxPortingOrderId: `po-${id}`,
      businessName: 'Acme',
    });
    await db.insert(schema.voipPortingOrders).values([
      order('vpo_hook_progress', '+31201260001'),
      order('vpo_hook_exception', '+31201260002'),
      order('vpo_hook_ported', '+31201260003'),
      order('vpo_hook_empty', '+31201260004'),
      order('vpo_hook_cancelled', '+31201260005'),
    ]);
    await master.insert(masterSchema.telnyxPortingOrderIndex).values(
      ['progress', 'exception', 'ported', 'empty', 'cancelled'].map((kind) => ({
        telnyxPortingOrderId: `po-vpo_hook_${kind}`,
        clerkOrgId: ORG,
        draftId: `vpo_hook_${kind}`,
      })),
    );
  });

  const order = async (id: string) => (await db.select().from(schema.voipPortingOrders).where(eq(schema.voipPortingOrders.id, id)))[0];
  const indexed = async (id: string) =>
    (await master.select().from(masterSchema.telnyxPortingOrderIndex).where(eq(masterSchema.telnyxPortingOrderIndex.draftId, id))).length;

  it('ignores orders it does not know', async () => {
    expect(await (await porting('in-process', { id: 'po-unknown' })).json()).toEqual({ ok: true });
    expect(await (await porting('in-process')).json()).toEqual({ ok: true });
  });

  it('follows an order through Telnyx', async () => {
    await porting('in-process', { id: 'po-vpo_hook_progress', sub_status: 'foc_set', actual_foc_date: '2026-11-30T09:00:00Z' });
    expect(await order('vpo_hook_progress')).toMatchObject({ status: 'in_process', substatus: 'foc_set' });
    expect((await order('vpo_hook_progress'))?.actualFocAt?.toISOString()).toBe('2026-11-30T09:00:00.000Z');
  });

  it('flags an exception and tells the porter', async () => {
    await porting('exception', { id: 'po-vpo_hook_exception', messages: [{ message: 'Name mismatch' }, { code: 'E42' }, {}] });
    expect(await order('vpo_hook_exception')).toMatchObject({
      status: 'exception',
      lastErrorCode: 'telnyx_exception',
      lastErrorMessage: 'Name mismatch; E42',
    });
    const [notice] = await db.select().from(schema.notifications).where(eq(schema.notifications.entityId, 'vpo_hook_exception'));
    expect(notice).toMatchObject({
      userId: 'user_porter',
      title: 'Port request needs attention',
      body: 'Telnyx flagged a problem on the port for 0201260002: Name mismatch; E42.',
      severity: 'warning',
      actionUrl: '/settings/apps/phone-numbers/port/vpo_hook_exception',
    });
    expect(await indexed('vpo_hook_exception')).toBe(1);
  });

  it('turns a completed port into a live number', async () => {
    telnyx.on('GET', '/porting_orders/po-vpo_hook_ported', { data: { id: 'po-vpo_hook_ported', status: 'ported', phone_numbers: [{ id: 'pn-ported', phone_number: '+31201260003' }] } });
    telnyx.on('GET', '/porting_orders/po-vpo_hook_empty', { data: { id: 'po-vpo_hook_empty', status: 'ported', phone_numbers: [] } });
    await porting('ported', { id: 'po-vpo_hook_ported' });
    const ported = await order('vpo_hook_ported');
    expect(ported).toMatchObject({ status: 'completed', lastErrorCode: null });
    const [number] = await db.select().from(schema.voipPhoneNumbers).where(eq(schema.voipPhoneNumbers.phoneNumber, '+31201260003'));
    expect(number).toMatchObject({
      id: ported?.voipPhoneNumberId,
      formattedNumber: '0201260003',
      providerPhoneNumberId: 'pn-ported',
      providerConnectionId: 'conn-1',
      displayName: 'Acme',
      status: 'active',
    });
    expect(await indexed('vpo_hook_ported')).toBe(0);
    const [registered] = await master.select().from(masterSchema.phoneNumberRegistry).where(eq(masterSchema.phoneNumberRegistry.phoneNumber, '+31201260003'));
    expect(registered).toMatchObject({ clerkOrgId: ORG, isActive: true });
    // A replay changes nothing.
    expect(await (await porting('ported', { id: 'po-vpo_hook_ported' })).json()).toEqual({ ok: true });

    await porting('ported', { id: 'po-vpo_hook_empty' });
    expect(await order('vpo_hook_empty')).toMatchObject({ status: 'submitted', lastErrorCode: 'completed_without_number' });
  });

  it('closes a cancelled port', async () => {
    await porting('cancelled', { id: 'po-vpo_hook_cancelled' });
    expect(await order('vpo_hook_cancelled')).toMatchObject({ status: 'cancelled' });
    expect(await indexed('vpo_hook_cancelled')).toBe(0);
  });
});

describe('inbound calls', () => {
  const inbound = (to: string, from: string, control = 'cc-inbound-1') =>
    deliver(callEvent('call.initiated', { direction: 'incoming', call_control_id: control, to, from, call_session_id: 'sess-1', call_leg_id: 'leg-1' }));

  const callTo = async (to: string) =>
    db.select().from(schema.voipCalls).where(and(eq(schema.voipCalls.toNumber, to), eq(schema.voipCalls.direction, 'inbound')));

  it('hangs up a number no workspace has, or one that takes no calls', async () => {
    telnyx.on('POST', '/calls/cc-unrouted/actions/hangup', { data: {} });
    expect(await (await inbound('+31209999999', '+31612350009', 'cc-unrouted')).json()).toEqual({ ok: true });
    expect(await (await inbound('+31201250004', '+31612350009', 'cc-unrouted')).json()).toEqual({ ok: true });
    expect(actionCalls(telnyx.calls, 'cc-unrouted', 'hangup').length).toBeGreaterThan(0);
    expect(await callTo('+31201250004')).toHaveLength(0);
  });

  it('forwards a call and opens the caller\x27s phone conversation', async () => {
    await inbound('+31201250001', '+31 6 1235 0001');
    const [call] = await callTo('+31201250001');
    expect(call).toMatchObject({
      userId: 'user_agent',
      fromNumber: '+31612350001',
      providerCallId: 'cc-inbound-1',
      providerSessionId: 'sess-1',
      status: 'initiated',
      contactId: 'per_hook_anna',
      isRecorded: true,
    });
    const [conversation] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, call!.deskConversationId!));
    expect(conversation).toMatchObject({ channel: 'phone', state: 'open', name: 'Anna Caller', contactId: 'per_hook_anna', title: 'Call from Anna Caller' });
    const messages = await messagesOf(conversation!.id);
    expect(messages.map((m) => [m.authorType, m.body])).toEqual([
      ['visitor', 'Inbound call from Anna Caller to +31201250001'],
      ['system', 'Forwarding call to +31612350100'],
    ]);
  });

  it('lets a voice agent answer, with the caller\x27s context', async () => {
    await inbound('+31201250002', '06-1235-0002');
    const [call] = await callTo('+31201250002');
    expect(call).toMatchObject({ contactId: null, customerId: null });
    const messages = await messagesOf(call!.deskConversationId!);
    expect(messages.map((m) => [m.authorType, m.authorId, m.body])).toEqual([
      ['visitor', expect.any(String), 'Inbound call from Bob Lead to +31201250002'],
      ['bot', 'dva_hook', 'AI agent “Front desk” answered the call (matched Bob Lead)'],
    ]);
    const [start] = actionCalls(telnyx.calls, 'cc-inbound-1', 'ai_assistant_start').slice(-1);
    const body = start!.body as { assistant: Record<string, unknown>; client_state: string };
    expect(body.assistant).toMatchObject({
      id: 'asst-hook',
      dynamic_variables: { caller_phone: '+0612350002', caller_name: 'Bob Lead', customer_name: 'Leadco' },
    });
    expect(String(body.assistant.instructions)).toContain('Be kind.\n\n## Live call context\nCaller phone: +0612350002\nMatched name: Bob Lead');
    expect(JSON.parse(atob(body.client_state))).toMatchObject({ workspaceId: ORG, record: 'true', voiceAgentId: 'dva_hook' });
  });

  it('hangs up without a route, or when the agent is off', async () => {
    await inbound('+31201250003', '+44 20 7946 0000');
    const [call] = await callTo('+31201250003');
    expect(call).toMatchObject({ isRecorded: false, fromNumber: '+442079460000' });
    expect((await messagesOf(call!.deskConversationId!)).map((m) => m.body)).toContain('Call ended (no inbound route configured)');
    await inbound('+31201250005', '+44 20 7946 0000');
    // The same caller's open conversation takes the second call.
    const [second] = await callTo('+31201250005');
    expect(second?.deskConversationId).toBe(call!.deskConversationId);
  });

  it('hangs up when the route fails', async () => {
    telnyx.on('POST', '/calls/cc-broken/actions/transfer', () => telnyxError(422, 'Bad target'));
    telnyx.on('POST', '/calls/cc-broken/actions/hangup', { data: {} });
    expect(await (await inbound('+31201250006', '+31612350010', 'cc-broken')).json()).toEqual({ ok: true });
    expect(actionCalls(telnyx.calls, 'cc-broken', 'hangup').length).toBeGreaterThan(0);
  });
});

describe('call events', () => {
  const state = (callId: string, extra: Record<string, string> = {}) =>
    encodeState({ callId, workspaceId: ORG, deskConversationId: 'dconv_hook_events', record: 'true', ...extra });

  beforeAll(async () => {
    await db.insert(schema.deskVisitors).values({ id: 'dvis_hook_events', name: 'Eve', phone: '+31612350050' });
    await db.insert(schema.deskConversations).values({
      id: 'dconv_hook_events', conversationNumber: 9001, title: 'Call from Eve', state: 'open', channel: 'phone', visitorId: 'dvis_hook_events',
    });
    await db.insert(schema.voipCalls).values([
      { id: 'vcall_hook_events', userId: 'system', direction: 'inbound', status: 'initiated', fromNumber: '+31612350050', toNumber: '+31201250001', deskConversationId: 'dconv_hook_events', initiatedAt: new Date('2026-10-10T10:00:00Z') },
      { id: 'vcall_hook_plain', userId: 'system', direction: 'outbound', status: 'initiated', fromNumber: '+31201250001', toNumber: '+31612350051', initiatedAt: new Date('2026-10-10T10:00:00Z') },
    ]);
    telnyx.on('POST', '/calls/cc-events/actions/record_start', { data: {} });
  });

  const call = async (id: string) => (await db.select().from(schema.voipCalls).where(eq(schema.voipCalls.id, id)))[0]!;

  it('follows the call', async () => {
    await deliver(callEvent('call.initiated', { client_state: state('vcall_hook_events'), call_control_id: 'cc-events', call_session_id: 'sess-e' }));
    expect(await call('vcall_hook_events')).toMatchObject({ providerCallId: 'cc-events', providerSessionId: 'sess-e', providerLegId: null });
    await deliver(callEvent('call.answered', { client_state: state('vcall_hook_events'), call_control_id: 'cc-events' }, '2026-10-10T10:00:03Z'));
    expect(await call('vcall_hook_events')).toMatchObject({ status: 'answered' });
    expect(actionCalls(telnyx.calls, 'cc-events', 'record_start').length).toBeGreaterThan(0);
    await deliver(callEvent('call.bridged', { client_state: state('vcall_hook_events') }));
    expect(await call('vcall_hook_events')).toMatchObject({ status: 'bridged' });
    await deliver(callEvent('call.machine.detection.ended', { client_state: state('vcall_hook_events'), result: 'human' }));
    await deliver(callEvent('call.speak.ended', { client_state: state('vcall_hook_events') }));
  });

  it('ends the call, settles its minutes and notes it on the conversation', async () => {
    const res = await deliver(
      callEvent(
        'call.hangup',
        {
          client_state: state('vcall_hook_events'),
          hangup_cause: 'user_busy',
          hangup_source: 'callee',
          sip_hangup_cause: '486',
          start_time: '2026-10-10T10:00:03Z',
          end_time: '2026-10-10T10:01:34.600Z',
        },
        '2026-10-10T10:01:35Z',
      ),
    );
    expect(await res.json()).toEqual({ ok: true });
    expect(await call('vcall_hook_events')).toMatchObject({
      status: 'busy',
      duration: 92,
      hangupCause: 'SIP 486 - user_busy',
      hangupSource: 'callee',
      creditsConsumed: 6,
    });
    const messages = await messagesOf('dconv_hook_events');
    expect(messages.map((m) => m.body)).toContain('Call ended (busy, 92s)');
    const [wallet] = await master.select().from(masterSchema.workspaceCredits).where(eq(masterSchema.workspaceCredits.workspaceId, 'ws_hook'));
    expect(wallet.currentBalance).toBe(4);

    await deliver(callEvent('call.hangup', { client_state: state('vcall_hook_plain', { deskConversationId: '' }) }));
    expect(await call('vcall_hook_plain')).toMatchObject({ status: 'completed', duration: null, hangupCause: 'normal_clearing', hangupSource: '' });
  });

  it('keeps the recording and the AI summary', async () => {
    await deliver(callEvent('call.recording.saved', { client_state: state('vcall_hook_events'), recording_urls: {} }));
    await deliver(
      callEvent('call.recording.saved', {
        client_state: state('vcall_hook_events'),
        recording_urls: { mp3: 'https://telnyx.test/rec.mp3' },
        recording_id: 'rec-1',
        duration_secs: 91.6,
      }),
    );
    expect(await call('vcall_hook_events')).toMatchObject({ recordingStorageUrl: 'https://telnyx.test/rec.mp3', recordingStorageKey: 'rec-1', recordingDuration: 92 });
    await deliver(callEvent('call.conversation_insights.generated', { client_state: state('vcall_hook_events'), conversation_insights: { summary: 'Asked about an invoice.' } }));
    expect(await call('vcall_hook_events')).toMatchObject({ aiSummary: 'Asked about an invoice.' });
    await deliver(callEvent('call.conversation_insights.generated', { client_state: state('vcall_hook_events'), summary: { topics: ['billing'] } }));
    expect(await call('vcall_hook_events')).toMatchObject({ aiSummary: '{"topics":["billing"]}' });
    const bodies = (await messagesOf('dconv_hook_events')).map((m) => m.body);
    expect(bodies).toEqual(expect.arrayContaining(['Call recording available', 'Asked about an invoice.', 'AI call summary generated']));
  });

  it('copies the AI conversation into the desk conversation', async () => {
    const history = (last: string) => [
      { role: 'assistant', content: 'Hello, how can I help?' },
      { role: 'user', content: [{ type: 'text', text: last }] },
      { role: 'tool', content: { text: 'lookup done' } },
      { role: 'user', content: '   ' },
    ];
    const transcriptState = state('vcall_hook_events', { voiceAgentId: 'dva_hook' });
    await deliver(callEvent('call.ai_gather.message_history_updated', { client_state: transcriptState, message_history: history('I have a') }));
    await deliver(callEvent('call.conversation.ended', { client_state: transcriptState, conversation: { messages: history('I have a question') } }));
    await deliver(callEvent('call.ai_gather.message_history_updated', { client_state: transcriptState, message_history: 'nope' }));
    const turns = (await messagesOf('dconv_hook_events')).filter((m) => (m.metadata as { event?: string } | null)?.event === 'ai_transcript');
    expect(turns.map((m) => [m.kind, m.authorType, m.authorId, m.body])).toEqual([
      ['message', 'bot', 'dva_hook', 'Hello, how can I help?'],
      ['message', 'visitor', 'dvis_hook_events', 'I have a question'],
      ['note', 'bot', 'dva_hook', 'lookup done'],
    ]);
  });
});

describe('the lookup_crm tool', () => {
  const tool = async (name: string, body: unknown, token?: string, env: Record<string, unknown> = {}) =>
    app(env).request(`${BASE}/tools/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    });

  it('needs Telnyx and a valid token', async () => {
    const token = await signDeskPhoneToolToken(API_KEY, { org: ORG, aid: 'dva_hook' });
    expect((await tool('lookup_crm', {}, token, { TELNYX_API_KEY: undefined })).status).toBe(503);
    expect(await (await tool('lookup_crm', {})).json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Missing tool token' } });
    expect(await (await tool('lookup_crm', {}, 'abc.def')).json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Invalid tool token' } });
    const expired = await signDeskPhoneToolToken(API_KEY, { org: ORG, aid: 'dva_hook', exp: 1 });
    expect((await tool('lookup_crm', {}, expired)).status).toBe(401);
    expect(await (await tool('book_meeting', {}, token)).json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Unknown tool book_meeting' } });
  });

  it('searches the CRM by name, email or phone', async () => {
    const token = await signDeskPhoneToolToken(API_KEY, { org: ORG, aid: 'dva_hook' });
    const byName = await tool('lookup_crm', { query: 'acme' }, token);
    expect(await byName.json()).toEqual({
      matched: 1,
      results: [{ type: 'customer', id: 'cmp_hook_acme', name: 'Acme BV', email: 'info@acme.test', phone: '+31 20 999 0000', company: 'Acme BV' }],
    });
    expect(await (await tool('lookup_crm', { email: 'bob@lead.test' }, token)).json()).toMatchObject({ matched: 1, results: [{ type: 'lead', name: 'Bob Lead' }] });
    expect(await (await tool('lookup_crm', { query: 'nobody' }, token)).json()).toEqual({ matched: 0, results: [], message: 'No matching CRM records.' });
    expect(await (await tool('lookup_crm', 'not an object', token)).json()).toEqual({ matched: 0, results: [], message: 'No matching CRM records.' });
  });

  it('falls back to the caller\x27s number and notes the lookup on the conversation', async () => {
    const token = await signDeskPhoneToolToken(API_KEY, { org: ORG, aid: 'dva_hook', call: 'vcall_hook_events', conv: 'dconv_hook_events' });
    const res = await tool('lookup_crm', { query: '  ' }, token);
    expect(await res.json()).toMatchObject({ matched: 0 });
    const notes = (await messagesOf('dconv_hook_events')).filter((m) => m.kind === 'note' && m.authorType === 'bot');
    expect(notes.map((n) => n.body)).toContain('CRM lookup for “+31612350050” returned no records');
    const named = await tool('lookup_crm', { name: 'Anna' }, token);
    expect(await named.json()).toMatchObject({ matched: 1 });
    expect((await messagesOf('dconv_hook_events')).map((m) => m.body)).toContain('CRM lookup for “Anna”: Anna Caller (contact)');
  });
});
