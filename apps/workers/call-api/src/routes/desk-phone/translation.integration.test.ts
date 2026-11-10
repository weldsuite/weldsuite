/**
 * Live call translation on pglite: /api/desk/phone/calls/:callId/translation
 * (start, change, stop and their refusals) and the `call.transcription`
 * webhook that turns each final line into a caption, a spoken translation and,
 * with recording on, a note on the call's conversation.
 *
 * Telnyx is a fetch stub answering by method and path (never by call order);
 * REALTIME records what is published; the model and the credit wallet are mocked.
 *
 * TypeScript only: Rust answers these routes 503 (no AI provider on the
 * Kubernetes editions), so they are excluded from its conformance suite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { conformanceMasterDb, conformanceTenantDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { VoipCallTranslation } from '@weldsuite/db/schema/voip-calls';
import { stubTelnyx, telnyxError } from '../../test/telnyx-stub';
import {
  BASE as WEBHOOK_BASE,
  NUMBERS,
  ORG,
  actionCalls,
  callEvent,
  decodeState,
  deliverWith,
  encodeState,
  env as webhookEnv,
  messagesOf,
  realtimeStub,
  seedPhoneWorkspace,
} from '../../test/phone-webhook-harness';

interface CreditParams {
  idempotencyKey: string;
  amount: number;
  serviceType: string;
  referenceId: string;
}

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));
const ai = vi.hoisted(() => ({
  generateObject: vi.fn(),
  assertGatewayConfigured: vi.fn(),
}));
const billing = vi.hoisted(() => ({
  assertAiCredits: vi.fn(async () => {}),
  chargeAiUsage: vi.fn(async (_metering: unknown, _params: Record<string, unknown>) => 1),
}));
const credits = vi.hoisted(() => ({
  consumeCredits: vi.fn(async (_db: unknown, _params: CreditParams) => ({ ok: true as const, transactionId: 'tx_1' })),
  grantCredits: vi.fn(async (_db: unknown, _params: CreditParams) => ({ transactionId: 'tx_2' })),
}));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(holder.master),
    getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  };
});
vi.mock('@weldsuite/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/ai')>();
  return {
    ...actual,
    generateObject: ai.generateObject,
    assertGatewayConfigured: ai.assertGatewayConfigured,
    createWeldAI: () => ({ model: (id: string) => ({ modelId: id }) }),
  };
});
vi.mock('@weldsuite/core-domain/ai-billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/core-domain/ai-billing')>();
  return {
    ...actual,
    resolveAiMetering: vi.fn(async () => ({ masterDb: {}, internalWsId: 'ws_internal', userId: 'user_anna' })),
    assertAiCredits: billing.assertAiCredits,
    chargeAiUsage: billing.chargeAiUsage,
  };
});
vi.mock('@weldsuite/credits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/credits')>();
  return {
    ...actual,
    resolveInternalWorkspaceId: async () => 'ws_internal',
    consumeCredits: credits.consumeCredits,
    grantCredits: credits.grantCredits,
  };
});

// Imported after the mocks.
const { deskPhoneRoutes } = await import('./index');
const { telnyxWebhookRoutes } = await import('../webhooks-telnyx/index');
const { InsufficientAiCreditsError } = await import('@weldsuite/core-domain/ai-billing');

vi.setConfig({ testTimeout: 60_000 });

const ALL = ['conversations:read', 'conversations:update'];
const usage = { inputTokens: 20, outputTokens: 10, totalTokens: 30 };

let db: Database;
const telnyx = stubTelnyx();
const realtime = realtimeStub();

const CALLER = 'cc-tr-caller';
const AGENT = 'cc-tr-agent';
const CALL = 'vcall_tr_1';
const CONVERSATION = 'dconv_tr_1';

/** What the mocked model answers: the text it is given, by language. */
const answers = new Map<string, { language: string; translation: string }>();

function routes(options: { userId?: string; grants?: string[]; configured?: boolean } = {}) {
  return createTestApp('/api/desk/phone', deskPhoneRoutes, {
    context: {
      userId: options.userId ?? 'user_anna',
      workspaceId: 'ws_queue',
      clerkOrgId: ORG,
      tenantDb: db,
      permissions: permissions(...(options.grants ?? ALL)),
    },
    env: { TELNYX_API_KEY: 'telnyx-key', REALTIME: realtime.binding } as never,
  });
}

function send(
  method: string,
  body?: unknown,
  options: { callId?: string; userId?: string; grants?: string[] } = {},
) {
  return routes(options).request(`/api/desk/phone/calls/${options.callId ?? CALL}/translation`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

const kv = new Map<string, string>();
const WORKSPACE_CACHE = {
  get: async (key: string) => kv.get(key) ?? null,
  put: async (key: string, value: string) => {
    kv.set(key, value);
  },
};

function webhooks() {
  return createTestApp(WEBHOOK_BASE, telnyxWebhookRoutes as never, {
    context: { tenantDb: db, masterDb: holder.master as Database, orgId: null, clerkOrgId: null },
    env: { ...webhookEnv(), REALTIME: realtime.binding, WORKSPACE_CACHE } as never,
  });
}

async function deliver(event: unknown) {
  const app = webhooks();
  const res = await deliverWith(app.request, event);
  await app.settled();
  return res;
}

let lineSeq = 0;
function transcription(
  side: 'caller' | 'agent',
  transcript: string,
  data: { is_final?: boolean; confidence?: number } = {},
  callId = CALL,
) {
  lineSeq += 1;
  const event = callEvent('call.transcription', {
    call_control_id: side === 'caller' ? CALLER : AGENT,
    client_state: encodeState({ workspaceId: ORG, callId, translate: side }),
    transcription_data: { transcript, is_final: data.is_final ?? true, confidence: data.confidence ?? 0.9, transcription_track: 'inbound' },
  });
  return { ...event, data: { ...event.data, id: `ev-line-${lineSeq}`, occurred_at: `2026-10-10T10:00:${String(lineSeq).padStart(2, '0')}Z` } };
}

const translation = (values: Partial<VoipCallTranslation> = {}): VoipCallTranslation => ({
  callerLanguage: 'nl',
  agentLanguage: 'en',
  speakToCaller: true,
  agentLegId: AGENT,
  startedAt: '2026-10-10T09:59:00.000Z',
  startedById: 'user_anna',
  stoppedAt: null,
  ...values,
});

async function seedCall(values: Partial<typeof schema.voipCalls.$inferInsert> = {}) {
  await db.insert(schema.voipCalls).values({
    id: CALL,
    userId: 'user_anna',
    direction: 'inbound',
    status: 'bridged',
    fromNumber: '+31612345000',
    toNumber: NUMBERS.agents,
    providerCallId: CALLER,
    initiatedAt: new Date('2026-10-10T09:58:00Z'),
    agentAnsweredAt: new Date('2026-10-10T09:58:30Z'),
    answeredByUserId: 'user_anna',
    outcome: 'answered',
    deskConversationId: CONVERSATION,
    ...values,
  });
  await db.insert(schema.deskPhoneCallLegs).values({ id: 'dleg_tr_1', callId: CALL, userId: 'user_anna', providerCallId: AGENT, status: 'answered' });
}

const callRow = async () => (await db.select().from(schema.voipCalls).where(eq(schema.voipCalls.id, CALL)))[0]!;
const commands = (control: string, action: string) => actionCalls(telnyx.calls, control, action);
const body = (call: { body: unknown }) => call.body as Record<string, unknown>;
const aiCalls = () => ai.generateObject.mock.calls.length;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const master = (await createMasterPgliteDb()).db;
  holder.master = master;
  holder.tenant = db;
  await seedPhoneWorkspace(db, master);
  await db.insert(schema.deskVisitors).values({ id: 'dvis_tr_1', name: 'Dirk', phone: '+31612345000' });
  await db.insert(schema.deskConversations).values({
    id: CONVERSATION, conversationNumber: 8101, title: 'Call from Dirk', state: 'open', channel: 'phone', visitorId: 'dvis_tr_1', name: 'Dirk',
  });
  for (const control of [CALLER, AGENT]) {
    for (const action of ['transcription_start', 'transcription_stop', 'speak']) {
      telnyx.on('POST', `/calls/${control}/actions/${action}`, { data: { result: 'ok' } });
    }
  }
  ai.generateObject.mockImplementation(async ({ prompt }: { prompt: string }) => ({
    object: answers.get(prompt) ?? { language: 'nl', translation: `EN:${prompt}` },
    usage,
  }));
}, 180_000);

beforeEach(async () => {
  await db.delete(schema.deskPhoneCallLegs);
  await db.delete(schema.voipCalls);
  await db.delete(schema.deskMessages);
  realtime.published.length = 0;
  telnyx.calls.length = 0;
  kv.clear();
  answers.clear();
  ai.generateObject.mockClear();
  ai.assertGatewayConfigured.mockReset();
  billing.assertAiCredits.mockReset();
  billing.assertAiCredits.mockResolvedValue(undefined);
  billing.chargeAiUsage.mockClear();
  credits.consumeCredits.mockClear();
  // Both legs answer by URL; a test overrides one to refuse.
  telnyx.on('POST', `/calls/${AGENT}/actions/transcription_start`, { data: { result: 'ok' } });
});

afterAll(() => vi.unstubAllGlobals());

describe('POST /calls/:callId/translation', () => {
  it('starts the transcription on both legs and keeps the state on the call', async () => {
    await seedCall();
    const res = await send('POST', { callerLanguage: 'auto', agentLanguage: 'en' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      callId: CALL, active: true, callerLanguage: null, agentLanguage: 'en', speakToCaller: true, speakAvailable: false,
      startedById: 'user_anna', stoppedAt: null,
    });

    const [caller] = commands(CALLER, 'transcription_start');
    const [agent] = commands(AGENT, 'transcription_start');
    expect(commands(CALLER, 'transcription_start')).toHaveLength(1);
    expect(commands(AGENT, 'transcription_start')).toHaveLength(1);
    expect(body(caller!)).toMatchObject({
      transcription_engine: 'Telnyx',
      transcription_engine_config: { transcription_model: 'openai/whisper-large-v3-turbo', language: 'auto_detect' },
      transcription_tracks: 'inbound',
    });
    expect(decodeState(body(caller!).client_state)).toEqual({ workspaceId: ORG, callId: CALL, translate: 'caller' });
    expect(body(agent!)).toMatchObject({
      transcription_engine_config: { language: 'en' },
      transcription_tracks: 'inbound',
    });
    expect(decodeState(body(agent!).client_state)).toEqual({ workspaceId: ORG, callId: CALL, translate: 'agent' });

    expect((await callRow()).translation).toMatchObject({ callerLanguage: null, agentLanguage: 'en', agentLegId: AGENT, stoppedAt: null });
  });

  it('starts with the caller language the agent chose', async () => {
    await seedCall();
    const res = await send('POST', { callerLanguage: 'uk', agentLanguage: 'nl', speakToCaller: true });
    expect(await res.json()).toMatchObject({ data: { callerLanguage: 'uk', speakAvailable: false } });
    expect(body(commands(CALLER, 'transcription_start')[0]!)).toMatchObject({ transcription_engine_config: { language: 'uk' } });
  });

  it('refuses a call that is not live, not inbound, not yours or already translated', async () => {
    const reason = async (res: Response) => ((await res.json()) as { error: { details: { reason: string } } }).error.details.reason;
    const start = { callerLanguage: 'auto', agentLanguage: 'en' };

    expect((await send('POST', start, { callId: 'vcall_missing' })).status).toBe(404);

    await seedCall({ endedAt: new Date() });
    let res = await send('POST', start);
    expect([res.status, await reason(res)]).toEqual([409, 'not_live']);
    await db.delete(schema.deskPhoneCallLegs);
    await db.delete(schema.voipCalls);

    await seedCall({ direction: 'outbound' });
    res = await send('POST', start);
    expect([res.status, await reason(res)]).toEqual([409, 'not_live']);
    await db.delete(schema.deskPhoneCallLegs);
    await db.delete(schema.voipCalls);

    await seedCall({ agentAnsweredAt: null, answeredByUserId: null, outcome: null });
    res = await send('POST', start);
    expect([res.status, await reason(res)]).toEqual([409, 'not_live']);
    await db.delete(schema.deskPhoneCallLegs);
    await db.delete(schema.voipCalls);

    await seedCall();
    res = await send('POST', start, { userId: 'user_bob' });
    expect([res.status, await reason(res)]).toEqual([409, 'not_your_call']);

    expect((await send('POST', start)).status).toBe(200);
    res = await send('POST', start);
    expect([res.status, await reason(res)]).toEqual([409, 'already_translating']);
    expect(commands(CALLER, 'transcription_start')).toHaveLength(1);
  });

  it('validates the body and the permission', async () => {
    await seedCall();
    expect((await send('POST', { callerLanguage: 'xx', agentLanguage: 'en' })).status).toBe(400);
    expect((await send('POST', { callerLanguage: 'auto', agentLanguage: 'auto' })).status).toBe(400);
    expect((await send('POST', { agentLanguage: 'en' })).status).toBe(400);
    expect((await send('POST', { callerLanguage: 'de', agentLanguage: 'en' }, { grants: ['conversations:read'] })).status).toBe(403);
    expect((await send('GET', undefined, { grants: ['conversations:update'] })).status).toBe(403);
  });

  it('answers 402 without credits, and starts nothing', async () => {
    await seedCall();
    billing.assertAiCredits.mockRejectedValueOnce(new InsufficientAiCreditsError(0, 1, 1));
    const res = await send('POST', { callerLanguage: 'de', agentLanguage: 'en' });
    expect(res.status).toBe(402);
    expect(telnyx.calls).toHaveLength(0);
    expect((await callRow()).translation).toBeNull();
  });

  it('answers 503 ai_unavailable when AI is not configured', async () => {
    await seedCall();
    ai.assertGatewayConfigured.mockImplementation(() => {
      throw new Error('no gateway');
    });
    const res = await send('POST', { callerLanguage: 'de', agentLanguage: 'en' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'ai_unavailable', message: 'AI is currently unavailable' } });
    expect(telnyx.calls).toHaveLength(0);
  });

  it('answers 502 and leaves nothing running when Telnyx refuses one leg', async () => {
    await seedCall();
    telnyx.on('POST', `/calls/${AGENT}/actions/transcription_start`, () => telnyxError(422, 'Call has already ended'));
    const res = await send('POST', { callerLanguage: 'de', agentLanguage: 'en' });
    expect(res.status).toBe(502);
    expect(commands(CALLER, 'transcription_start')).toHaveLength(1);
    expect(commands(CALLER, 'transcription_stop')).toHaveLength(1);
    expect((await callRow()).translation).toBeNull();
  });
});

describe('GET /calls/:callId/translation', () => {
  it('reads the state, or null before any', async () => {
    await seedCall();
    expect(await (await send('GET')).json()).toEqual({ data: null });
    await send('POST', { callerLanguage: 'de', agentLanguage: 'en' });
    expect(await (await send('GET')).json()).toMatchObject({ data: { active: true, callerLanguage: 'de', speakAvailable: true } });
  });
});

describe('PATCH /calls/:callId/translation', () => {
  it('refuses when nothing is translated', async () => {
    await seedCall();
    const res = await send('PATCH', { speakToCaller: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { details: { reason: 'not_translating' } } });
  });

  it('restarts the caller side when the caller language changes, and only then', async () => {
    await seedCall();
    await send('POST', { callerLanguage: 'auto', agentLanguage: 'en' });

    const toggled = await send('PATCH', { speakToCaller: false });
    expect(await toggled.json()).toMatchObject({ data: { speakToCaller: false } });
    expect(commands(CALLER, 'transcription_stop')).toHaveLength(0);

    const changed = await send('PATCH', { callerLanguage: 'de' });
    expect(await changed.json()).toMatchObject({ data: { callerLanguage: 'de', speakToCaller: false } });
    expect(commands(CALLER, 'transcription_stop')).toHaveLength(1);
    const starts = commands(CALLER, 'transcription_start');
    expect(starts).toHaveLength(2);
    expect(body(starts[1]!)).toMatchObject({ transcription_engine_config: { language: 'de' } });
    expect(commands(AGENT, 'transcription_start')).toHaveLength(1);
    expect((await callRow()).translation).toMatchObject({ callerLanguage: 'de', speakToCaller: false });
  });
});

describe('DELETE /calls/:callId/translation', () => {
  it('stops both transcriptions, charges the minutes once and tells the browser', async () => {
    await seedCall();
    await send('POST', { callerLanguage: 'de', agentLanguage: 'en' });
    realtime.published.length = 0;

    const res = await send('DELETE');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { active: boolean; stoppedAt: string } };
    expect(data.active).toBe(false);
    expect(data.stoppedAt).toBeTruthy();
    expect(commands(CALLER, 'transcription_stop')).toHaveLength(1);
    expect(commands(AGENT, 'transcription_stop')).toHaveLength(1);

    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
    expect(credits.consumeCredits.mock.calls[0]![1]).toMatchObject({
      workspaceId: 'ws_internal',
      amount: 2,
      serviceType: 'call_transcription',
      referenceId: CALL,
      idempotencyKey: expect.stringContaining(`voip-translate:${CALL}`),
    });
    expect(realtime.inbox('user_anna', 'phone.translation')[0]!.data).toMatchObject({ callId: CALL, active: false, stoppedReason: null });

    const again = await send('DELETE');
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { details: { reason: 'not_translating' } } });
    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
  });

  it('refuses a member who did not answer, and a call nobody translates', async () => {
    await seedCall();
    expect((await send('DELETE')).status).toBe(409);
    const other = await send('DELETE', undefined, { userId: 'user_bob' });
    expect(await other.json()).toMatchObject({ error: { details: { reason: 'not_your_call' } } });
  });

  it('can be started again after a stop', async () => {
    await seedCall();
    await send('POST', { callerLanguage: 'de', agentLanguage: 'en' });
    await send('DELETE');
    expect((await send('POST', { callerLanguage: 'fr', agentLanguage: 'en' })).status).toBe(200);
    expect((await callRow()).translation).toMatchObject({ callerLanguage: 'fr', stoppedAt: null });
  });
});

describe('call.transcription lines', () => {
  it('translates a caller line for the agent and does not speak it', async () => {
    await seedCall({ translation: translation() });
    answers.set('Ik wil mijn pakket volgen', { language: 'nl', translation: 'I want to track my parcel' });
    expect((await deliver(transcription('caller', 'Ik wil mijn pakket volgen'))).status).toBe(200);

    const [caption] = realtime.inbox('user_anna', 'phone.caption');
    expect(caption!.data).toMatchObject({
      callId: CALL,
      lineId: 'ev-line-1',
      speaker: 'caller',
      text: 'Ik wil mijn pakket volgen',
      translation: 'I want to track my parcel',
      sourceLanguage: 'nl',
      targetLanguage: 'en',
      at: '2026-10-10T10:00:01Z',
    });
    expect(realtime.published.filter((p) => p.event === 'phone.caption')).toHaveLength(1);
    expect(commands(CALLER, 'speak')).toHaveLength(0);
    expect(commands(AGENT, 'speak')).toHaveLength(0);
    expect(billing.chargeAiUsage).toHaveBeenCalledTimes(1);
    expect(billing.chargeAiUsage.mock.calls[0]![1]).toMatchObject({ op: 'call_translate', usage, referenceId: CALL });
  });

  it('translates an agent line, publishes it and speaks it on the caller leg only', async () => {
    await seedCall({ translation: translation() });
    answers.set('One moment please', { language: 'en', translation: 'Een moment alstublieft' });
    await deliver(transcription('agent', 'One moment please'));

    expect(realtime.inbox('user_anna', 'phone.caption')[0]!.data).toMatchObject({
      speaker: 'agent', text: 'One moment please', translation: 'Een moment alstublieft', sourceLanguage: 'en', targetLanguage: 'nl',
    });
    const speaks = commands(CALLER, 'speak');
    expect(speaks).toHaveLength(1);
    expect(body(speaks[0]!)).toEqual({ payload: 'Een moment alstublieft', voice: 'female', language: 'nl-NL', target_legs: 'self' });
    expect(commands(AGENT, 'speak')).toHaveLength(0);
  });

  it('only captions when the caller language has no voice, or speaking is off', async () => {
    await seedCall({ translation: translation({ callerLanguage: 'uk' }) });
    await deliver(transcription('agent', 'Hello there'));
    expect(realtime.inbox('user_anna', 'phone.caption')).toHaveLength(1);
    expect(commands(CALLER, 'speak')).toHaveLength(0);

    await db.update(schema.voipCalls).set({ translation: translation({ callerLanguage: 'nl', speakToCaller: false }) }).where(eq(schema.voipCalls.id, CALL));
    await deliver(transcription('agent', 'Hello again'));
    expect(realtime.inbox('user_anna', 'phone.caption')).toHaveLength(2);
    expect(commands(CALLER, 'speak')).toHaveLength(0);
  });

  it('ignores interim results, one-letter transcripts and a call nobody translates', async () => {
    await seedCall({ translation: translation() });
    await deliver(transcription('caller', 'Ik wil', { is_final: false }));
    await deliver(transcription('caller', ' a '));
    await deliver(transcription('caller', ''));
    await db.update(schema.voipCalls).set({ translation: translation({ stoppedAt: '2026-10-10T10:00:00.000Z' }) }).where(eq(schema.voipCalls.id, CALL));
    await deliver(transcription('caller', 'Hallo daar'));
    expect(aiCalls()).toBe(0);
    expect(realtime.published.filter((p) => p.event === 'phone.caption')).toHaveLength(0);
  });

  it('shows the text once and makes no model call when both sides speak one language', async () => {
    await seedCall({ translation: translation({ callerLanguage: 'en', agentLanguage: 'en' }) });
    await deliver(transcription('caller', 'I need help with my invoice'));
    expect(aiCalls()).toBe(0);
    expect(billing.chargeAiUsage).not.toHaveBeenCalled();
    expect(realtime.inbox('user_anna', 'phone.caption')[0]!.data).toMatchObject({ translation: null, sourceLanguage: 'en', targetLanguage: 'en' });
  });

  it('detects the caller language and locks it in after two agreeing utterances', async () => {
    await seedCall({ translation: translation({ callerLanguage: null }) });
    answers.set('Guten Tag', { language: 'de', translation: 'Good day' });
    answers.set('Ich brauche Hilfe', { language: 'de', translation: 'I need help' });

    await deliver(transcription('caller', 'Guten Tag'));
    expect((await callRow()).translation!.callerLanguage).toBeNull();
    expect(realtime.inbox('user_anna', 'phone.caption')[0]!.data).toMatchObject({ translation: 'Good day', sourceLanguage: 'de', targetLanguage: 'en' });

    await deliver(transcription('caller', 'Ich brauche Hilfe'));
    expect((await callRow()).translation!.callerLanguage).toBe('de');
    expect(realtime.inbox('user_anna', 'phone.translation')[0]!.data).toMatchObject({
      callId: CALL, active: true, callerLanguage: 'de', speakAvailable: true, stoppedReason: null,
    });

    // From now on the language is known: the caption of the agent's line goes into German.
    answers.set('Sure', { language: 'en', translation: 'Natürlich' });
    await deliver(transcription('agent', 'Sure'));
    expect(body(commands(CALLER, 'speak')[0]!)).toMatchObject({ payload: 'Natürlich', language: 'de-DE' });
  });

  it('does not lock the language on a doubtful or disagreeing utterance', async () => {
    await seedCall({ translation: translation({ callerLanguage: null }) });
    answers.set('mm hallo', { language: 'de', translation: 'mm hello' });
    answers.set('Bonjour', { language: 'fr', translation: 'Hello' });
    await deliver(transcription('caller', 'mm hallo', { confidence: 0.2 }));
    await deliver(transcription('caller', 'Bonjour'));
    await deliver(transcription('caller', 'mm hallo', { confidence: 0.9 }));
    expect((await callRow()).translation!.callerLanguage).toBeNull();
  });

  it('shows an agent line untranslated while the caller language is unknown', async () => {
    await seedCall({ translation: translation({ callerLanguage: null }) });
    await deliver(transcription('agent', 'Hello, how can I help?'));
    expect(aiCalls()).toBe(0);
    expect(realtime.inbox('user_anna', 'phone.caption')[0]!.data).toMatchObject({ translation: null, targetLanguage: null });
    expect(commands(CALLER, 'speak')).toHaveLength(0);
  });

  it('drops a line whose translation fails and still answers 200', async () => {
    await seedCall({ translation: translation() });
    ai.generateObject.mockRejectedValueOnce(new Error('model down'));
    const res = await deliver(transcription('caller', 'Goedemorgen'));
    expect(res.status).toBe(200);
    expect(realtime.published.filter((p) => p.event === 'phone.caption')).toHaveLength(0);
    expect(billing.chargeAiUsage).not.toHaveBeenCalled();
    expect((await callRow()).translation!.stoppedAt).toBeNull();
  });

  it('stops the translation when the wallet runs empty mid-call', async () => {
    await seedCall({ translation: translation() });
    billing.assertAiCredits.mockRejectedValueOnce(new InsufficientAiCreditsError(0, 1, 1));
    await deliver(transcription('caller', 'Goedemorgen'));
    expect((await callRow()).translation!.stoppedAt).not.toBeNull();
    expect(realtime.inbox('user_anna', 'phone.translation')[0]!.data).toMatchObject({ active: false, stoppedReason: 'no_credits' });
    expect(realtime.published.filter((p) => p.event === 'phone.caption')).toHaveLength(0);
    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
  });

  it('keeps each line on the conversation when the number records, and nothing when it does not', async () => {
    await seedCall({ translation: translation() });
    answers.set('Waar is mijn bestelling', { language: 'nl', translation: 'Where is my order' });
    await deliver(transcription('caller', 'Waar is mijn bestelling'));
    const notes = (await messagesOf(db, CONVERSATION)).filter((m) => (m.metadata as { event?: string } | null)?.event === 'call_translation');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'note', body: 'Waar is mijn bestelling\nWhere is my order' });
    expect(notes[0]!.metadata).toMatchObject({
      callId: CALL, lineId: 'ev-line-' + lineSeq, speaker: 'caller', original: 'Waar is mijn bestelling', translation: 'Where is my order',
      sourceLanguage: 'nl', targetLanguage: 'en',
    });

    await db.delete(schema.deskMessages);
    await db.update(schema.voipCalls).set({ toNumber: NUMBERS.norecord }).where(eq(schema.voipCalls.id, CALL));
    await deliver(transcription('caller', 'Waar is mijn bestelling'));
    expect(await messagesOf(db, CONVERSATION)).toHaveLength(0);
    // The caption itself is not stored, but it is still shown.
    expect(realtime.inbox('user_anna', 'phone.caption')).toHaveLength(2);
  });
});

describe('call.hangup of a translated call', () => {
  const hangup = () =>
    callEvent('call.hangup', {
      call_control_id: CALLER,
      client_state: encodeState({ workspaceId: ORG, callId: CALL }),
      hangup_cause: 'normal_clearing',
    }, '2026-10-10T10:05:00Z');

  it('stops the translation and charges its minutes once, however often Telnyx repeats the hangup', async () => {
    await seedCall({ translation: translation({ startedAt: '2026-10-10T10:00:00.000Z' }) });
    expect((await deliver(hangup())).status).toBe(200);
    expect((await callRow()).translation!.stoppedAt).toBe('2026-10-10T10:05:00.000Z');
    // Five minutes at two credits a minute; the legs are gone, so no stop command.
    const translated = () => credits.consumeCredits.mock.calls.filter((c) => c[1].idempotencyKey.startsWith('voip-translate:'));
    expect(translated()).toHaveLength(1);
    expect(translated()[0]![1]).toMatchObject({ amount: 10, serviceType: 'call_transcription' });
    expect(commands(CALLER, 'transcription_stop')).toHaveLength(0);
    expect(realtime.inbox('user_anna', 'phone.translation')[0]!.data).toMatchObject({ active: false, stoppedReason: 'call_ended' });

    await deliver(hangup());
    expect(translated()).toHaveLength(1);
  });

  it('charges nothing for a call that was never translated', async () => {
    await seedCall();
    await deliver(hangup());
    expect(credits.consumeCredits.mock.calls.filter((c) => c[1].idempotencyKey.startsWith('voip-translate:'))).toHaveLength(0);
  });
});
