/**
 * /api/desk/phone on pglite: voice agents (kept in sync with a Telnyx AI
 * assistant when Telnyx is configured), the inbound route of each number,
 * and the live transfer of a call. Telnyx is a fetch stub answering by URL,
 * shared with the Rust server in conformance mode.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { json, stubTelnyx, telnyxError, type TelnyxCall } from '../../test/telnyx-stub';
import { deskPhoneRoutes } from './index';

const BASE = '/api/desk/phone';
const ALL = ['conversations:read', 'conversations:update', 'settings:manage'];

let db: Database;
const telnyx = stubTelnyx();

function send(method: string, path: string, body?: unknown, options: { configured?: boolean; grants?: string[]; raw?: string } = {}) {
  const { request } = createTestApp(BASE, deskPhoneRoutes, {
    context: { tenantDb: db, permissions: permissions(...(options.grants ?? ALL)) },
    env: (options.configured ? { TELNYX_API_KEY: 'telnyx-key' } : {}) as never,
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

/** The assistant payloads Telnyx was sent (both backends' in conformance mode). */
const assistantBodies = (calls: TelnyxCall[]) =>
  calls.filter((c) => c.url.pathname.startsWith('/v2/ai/assistants') && c.method === 'POST').map((c) => c.body as Record<string, unknown>);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.voipPhoneNumbers).values([
    { id: 'vpn_dp_main', provider: 'telnyx', phoneNumber: '+31201240001', countryCode: 'NL', status: 'active' },
    { id: 'vpn_dp_gone', provider: 'telnyx', phoneNumber: '+31201240002', countryCode: 'NL', status: 'active', deletedAt: new Date() },
  ]);
  await db.insert(schema.voipCalls).values([
    {
      id: 'vcall_dp_live', userId: 'system', direction: 'inbound', status: 'answered', fromNumber: '+31612340001',
      toNumber: '+31201240001', providerCallId: 'cc-live-1', deskConversationId: 'dconv_dp_1', initiatedAt: new Date(),
    },
    {
      id: 'vcall_dp_plain', userId: 'system', direction: 'inbound', status: 'answered', fromNumber: '+31612340002',
      toNumber: '+31201240001', providerCallId: 'cc-live-2', initiatedAt: new Date(),
    },
    {
      id: 'vcall_dp_none', userId: 'system', direction: 'inbound', status: 'initiated', fromNumber: '+31612340003',
      toNumber: '+31201240001', initiatedAt: new Date(),
    },
  ]);
  telnyx.on('POST', '/ai/assistants', ({ body }) =>
    (body as { name: string }).name === 'Refused' ? telnyxError(422, 'Bad model') : json({ data: { id: 'asst-new' } }),
  );
}, 180_000);

afterAll(() => vi.unstubAllGlobals());

describe('voice agents', () => {
  it('validates the agent', async () => {
    expect((await send('POST', '/agents', { name: '', systemPrompt: 'Help' })).status).toBe(400);
    expect((await send('POST', '/agents', { name: 'A', systemPrompt: 'Help', forwardToE164: '0612345678' })).status).toBe(400);
    expect((await send('PATCH', '/agents/dva_x', { enabled: 'yes' })).status).toBe(400);
  });

  it('creates agents, with their Telnyx assistant when Telnyx is configured', async () => {
    const local = await send('POST', '/agents', { name: 'Local', systemPrompt: 'Help callers', enabled: false });
    expect(local.status).toBe(201);
    expect(await local.json()).toMatchObject({
      data: { name: 'Local', systemPrompt: 'Help callers', telnyxAssistantId: null, enabled: false, greeting: null },
    });

    const synced = await send(
      'POST',
      '/agents',
      { name: 'Front desk', systemPrompt: 'Help callers', greeting: 'Hi!', forwardToE164: '+31612340099', voice: 'alloy' },
      { configured: true },
    );
    expect(synced.status).toBe(201);
    const { data } = (await synced.json()) as { data: { id: string; telnyxAssistantId: string } };
    expect(data.telnyxAssistantId).toBe('asst-new');
    const [payload] = assistantBodies(telnyx.calls).filter((b) => b.name === 'Front desk');
    expect(payload).toMatchObject({
      instructions: 'Help callers',
      model: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
      greeting: 'Hi!',
      voice_settings: { voice: 'alloy' },
      enabled_features: ['telephony'],
      telephony_settings: { send_message_history_updates: true },
    });
    const tools = payload!.tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.type)).toEqual(['hangup', 'webhook', 'transfer']);
    expect(tools[1]).toMatchObject({
      webhook: { name: 'lookup_crm', url: 'https://call-api-test.weldsuite.org/public/webhooks/telnyx/tools/lookup_crm', method: 'POST' },
    });

    const refused = await send('POST', '/agents', { name: 'Refused', systemPrompt: 'x' }, { configured: true });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Failed to create Telnyx AI assistant' } });
  });

  it('lists and reads agents', async () => {
    const listed = (await (await send('GET', '/agents')).json()) as { data: Array<{ name: string }>; pagination: unknown };
    expect(listed.data.map((a) => a.name).sort()).toEqual(['Front desk', 'Local']);
    expect(listed.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });
    const [agent] = await db.select().from(schema.deskVoiceAgents).where(eq(schema.deskVoiceAgents.name, 'Local'));
    expect((await send('GET', `/agents/${agent!.id}`)).status).toBe(200);
    expect((await send('GET', '/agents/dva_missing')).status).toBe(404);
  });

  it('updates an agent and its assistant, creating one when it has none', async () => {
    const [local] = await db.select().from(schema.deskVoiceAgents).where(eq(schema.deskVoiceAgents.name, 'Local'));
    const [front] = await db.select().from(schema.deskVoiceAgents).where(eq(schema.deskVoiceAgents.name, 'Front desk'));
    expect((await send('PATCH', '/agents/dva_missing', { name: 'x' })).status).toBe(404);

    const plain = await send('PATCH', `/agents/${local!.id}`, { greeting: 'Hello', model: null });
    expect(await plain.json()).toMatchObject({ data: { name: 'Local', greeting: 'Hello', telnyxAssistantId: null } });

    const created = await send('PATCH', `/agents/${local!.id}`, { enabled: true }, { configured: true });
    expect(await created.json()).toMatchObject({ data: { enabled: true, telnyxAssistantId: 'asst-new' } });

    telnyx.on('POST', '/ai/assistants/asst-new', ({ body }) =>
      (body as { name: string }).name === 'Broken' ? telnyxError(500) : json({ data: { id: 'asst-new' } }),
    );
    const updated = await send('PATCH', `/agents/${front!.id}`, { greeting: null, forwardToE164: null }, { configured: true });
    expect(await updated.json()).toMatchObject({ data: { greeting: null, forwardToE164: null, telnyxAssistantId: 'asst-new' } });
    const broken = await send('PATCH', `/agents/${front!.id}`, { name: 'Broken' }, { configured: true });
    expect(await broken.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Failed to sync Telnyx AI assistant' } });
  });

  it('deletes an agent and its assistant, whatever Telnyx says', async () => {
    const [front] = await db.select().from(schema.deskVoiceAgents).where(eq(schema.deskVoiceAgents.name, 'Front desk'));
    telnyx.on('DELETE', '/ai/assistants/asst-new', () => telnyxError(500));
    expect((await send('DELETE', '/agents/dva_missing')).status).toBe(404);
    expect((await send('DELETE', `/agents/${front!.id}`, undefined, { configured: true })).status).toBe(204);
    expect((await send('GET', `/agents/${front!.id}`)).status).toBe(404);
  });

  it('needs its permissions', async () => {
    expect((await send('GET', '/agents', undefined, { grants: ['settings:manage'] })).status).toBe(403);
    expect((await send('POST', '/agents', { name: 'x', systemPrompt: 'y' }, { grants: ['conversations:read'] })).status).toBe(403);
  });
});

describe('inbound routes', () => {
  it('validates the route', async () => {
    expect((await send('PUT', '/routes', { voipPhoneNumberId: 'vpn_dp_main', action: 'ai_agent' })).status).toBe(400);
    expect((await send('PUT', '/routes', { voipPhoneNumberId: 'vpn_dp_main', action: 'forward', forwardToE164: '' })).status).toBe(400);
    expect((await send('PUT', '/routes', { voipPhoneNumberId: '', action: 'forward', forwardToE164: '+3161' })).status).toBe(400);
    expect((await send('PUT', '/routes', { voipPhoneNumberId: 'vpn_dp_main', action: 'voicemail' })).status).toBe(400);
  });

  it('needs a live number and agent', async () => {
    expect((await send('PUT', '/routes', { voipPhoneNumberId: 'vpn_dp_gone', action: 'hangup' })).status).toBe(404);
    const noAgent = await send('PUT', '/routes', { voipPhoneNumberId: 'vpn_dp_main', action: 'ai_agent', voiceAgentId: 'dva_missing' });
    expect(await noAgent.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Voice agent with ID 'dva_missing' not found" } });
  });

  it('creates and then replaces a number\x27s route', async () => {
    const created = await send('PUT', '/routes', { voipPhoneNumberId: 'vpn_dp_main', action: 'forward', forwardToE164: '+31612340100' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      data: { voipPhoneNumberId: 'vpn_dp_main', action: 'forward', forwardToE164: '+31612340100', voiceAgentId: null, schedule: null },
    });
    const [local] = await db.select().from(schema.deskVoiceAgents).where(eq(schema.deskVoiceAgents.name, 'Local'));
    const replaced = await send('PUT', '/routes', { voipPhoneNumberId: 'vpn_dp_main', action: 'ai_agent', voiceAgentId: local!.id });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ data: { action: 'ai_agent', voiceAgentId: local!.id, forwardToE164: null } });
    const listed = (await (await send('GET', '/routes')).json()) as { data: unknown[] };
    expect(listed.data).toHaveLength(1);
  });
});

describe('POST /forward-live', () => {
  it('checks the call and the target', async () => {
    expect((await send('POST', '/forward-live', { callId: 'vcall_dp_live', to: '0612' }, { configured: true })).status).toBe(400);
    expect((await send('POST', '/forward-live', undefined, { configured: true, raw: 'not json' })).status).toBe(400);
    const off = await send('POST', '/forward-live', { callId: 'vcall_dp_live', to: '+31612340100' });
    expect(await off.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Phone service is not activated' } });
    expect((await send('POST', '/forward-live', { callId: 'vcall_dp_none', to: '+31612340100' }, { configured: true })).status).toBe(404);
  });

  it('transfers the call with its client state', async () => {
    telnyx.on('POST', '/calls/cc-live-1/actions/transfer', ({ body }) => json({ data: { result: 'ok', echo: body } }));
    const res = await send('POST', '/forward-live', { callId: 'vcall_dp_live', to: '+31612340100' }, { configured: true });
    expect(await res.json()).toEqual({ data: { ok: true } });
    const [call] = telnyx.calls.filter((c) => c.url.pathname === '/v2/calls/cc-live-1/actions/transfer');
    const body = call!.body as { to: string; from: string; client_state: string };
    expect(body).toMatchObject({ to: '+31612340100', from: '+31201240001' });
    expect(JSON.parse(atob(body.client_state))).toEqual({
      callId: 'vcall_dp_live',
      workspaceId: 'org_test_default',
      deskConversationId: 'dconv_dp_1',
    });

    const failed = await send('POST', '/forward-live', { callId: 'vcall_dp_plain', to: '+31612340100' }, { configured: true });
    expect(await failed.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Transfer failed' } });
  });
});
