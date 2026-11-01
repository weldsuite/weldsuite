/**
 * /api/call-intelligence on pglite: the workspace's phone numbers (list,
 * create, update, soft delete), the WebRTC token (Telnyx telephony
 * credentials, through a fetch stub answering by URL), call statistics and a
 * call's transcription, which follows the call's owner scope.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { json, stubTelnyx, telnyxError } from '../../test/telnyx-stub';
import { callIntelligenceRoutes } from './index';

const BASE = '/api/call-intelligence';
const ALL = ['activities:read', 'activities:create', 'activities:update', 'activities:delete', 'activities:scope:all'];
const TELNYX_ENV = { TELNYX_API_KEY: 'telnyx-key', TELNYX_SIP_CONNECTION_ID: 'sip-conn-1' };

let db: Database;
const telnyx = stubTelnyx();

function send(
  method: string,
  path: string,
  body?: unknown,
  options: { userId?: string; grants?: string[]; env?: Record<string, unknown> } = {},
) {
  const { request } = createTestApp(BASE, callIntelligenceRoutes, {
    context: { userId: options.userId ?? 'user_ci', tenantDb: db, permissions: permissions(...(options.grants ?? ALL)) },
    env: (options.env ?? {}) as never,
  });
  return request(`${BASE}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.voipCalls).values([
    {
      id: 'vcall_ci_mine', userId: 'user_ci', direction: 'outbound', status: 'completed', fromNumber: '+31200000001',
      toNumber: '+31600000001', duration: 90, isRecorded: true, creditsConsumed: 6, initiatedAt: new Date('2026-10-01T08:00:00Z'),
    },
    {
      id: 'vcall_ci_theirs', userId: 'user_other', direction: 'inbound', status: 'answered', fromNumber: '+31600000002',
      toNumber: '+31200000002', duration: 31, isRecorded: false, initiatedAt: new Date('2026-10-02T08:00:00Z'),
    },
    {
      id: 'vcall_ci_bare', userId: 'user_ci', direction: 'outbound', status: 'initiated', fromNumber: '+31200000003',
      toNumber: '+31600000003', initiatedAt: new Date('2026-10-03T08:00:00Z'),
    },
  ]);
  await db.insert(schema.crmTranscriptions).values({
    id: 'trans_ci_1',
    activityId: 'vcall_ci_mine',
    status: 'completed',
    fullText: 'Hello there',
    language: 'en',
    wordCount: 2,
    speakerCount: 2,
    confidence: 0.75,
    processingStartedAt: new Date('2026-10-01T08:05:00Z'),
    processingCompletedAt: new Date('2026-10-01T08:06:00Z'),
  });
  await db.insert(schema.crmTranscriptSegments).values([
    { id: 'seg_ci_2', transcriptionId: 'trans_ci_1', speakerId: 1, speakerLabel: 'Speaker 2', text: 'there', startTime: 1.5, endTime: 2.25, sequenceNumber: 2 },
    { id: 'seg_ci_1', transcriptionId: 'trans_ci_1', speakerId: 0, speakerLabel: 'Speaker 1', text: 'Hello', startTime: 0, endTime: 1.5, sequenceNumber: 1 },
  ]);
}, 180_000);

afterAll(() => vi.unstubAllGlobals());

describe('phone numbers', () => {
  it('creates, lists, updates and deletes numbers', async () => {
    const created = await send('POST', '/phone-numbers', {
      phoneNumber: '+31201112233',
      countryCode: 'NL',
      displayName: 'Main line',
      isDefault: true,
      providerPhoneNumberId: null,
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const second = await send('POST', '/phone-numbers', { phoneNumber: '+31201112244', countryCode: 'NL', numberType: 'mobile', status: 'pending' });
    expect(second.status).toBe(201);

    const listed = (await (await send('GET', '/phone-numbers')).json()) as { data: Array<Record<string, unknown>> };
    expect(listed.data.map((n) => n.phoneNumber)).toEqual(['+31201112233', '+31201112244']);
    expect(listed.data[0]).toMatchObject({ provider: 'telnyx', status: 'active', numberType: 'local', allowInbound: true });
    const pending = (await (await send('GET', '/phone-numbers?status=pending&provider=telnyx')).json()) as { data: unknown[] };
    expect(pending.data).toHaveLength(1);

    const updated = await send('PATCH', `/phone-numbers/${data.id}`, { displayName: null, allowOutbound: false, status: '' });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ data: { id: data.id } });

    expect((await send('DELETE', `/phone-numbers/${data.id}`)).status).toBe(204);
    expect((await send('DELETE', `/phone-numbers/${data.id}`)).status).toBe(404);
    expect((await send('PATCH', `/phone-numbers/${data.id}`, { status: 'active' })).status).toBe(404);
  });

  it('validates, and refuses a duplicate number', async () => {
    expect((await send('POST', '/phone-numbers', { phoneNumber: '', countryCode: 'NL', provider: 'twilio' })).status).toBe(400);
    expect((await send('PATCH', '/phone-numbers/vnum_x', { isDefault: 'yes' })).status).toBe(400);
    await send('POST', '/phone-numbers', { phoneNumber: '+31201119999', countryCode: 'NL' });
    const duplicate = await send('POST', '/phone-numbers', { phoneNumber: '+31201119999', countryCode: 'NL' });
    expect(duplicate.status).toBe(500);
    expect(await duplicate.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create phone number' } });
  });
});

describe('POST /token', () => {
  it('says so when Telnyx is not configured', async () => {
    const res = await send('POST', '/token');
    expect(await res.json()).toEqual({
      data: {
        token: null,
        message: 'Telnyx is not configured. Set TELNYX_API_KEY and TELNYX_SIP_CONNECTION_ID.',
        configured: false,
        provider: 'telnyx',
      },
    });
  });

  it('mints a token for the existing credential, or creates one first', async () => {
    telnyx.on('GET', '/telephony_credentials', ({ url }) =>
      url.searchParams.get('filter[connection_id]') === 'sip-conn-1'
        ? json({ data: [{ id: 'cred-123' }] })
        : json({ data: [] }),
    );
    telnyx.on('POST', '/telephony_credentials', { data: { id: 'cred-new-1' } });
    telnyx.on('POST', '/telephony_credentials/cred-123/token', () => new Response('jwt-existing'));
    telnyx.on('POST', '/telephony_credentials/cred-new-1/token', () => new Response('jwt-new'));

    const existing = await send('POST', '/token', undefined, { env: TELNYX_ENV });
    expect(await existing.json()).toEqual({ data: { token: 'jwt-existing', configured: true, provider: 'telnyx' } });

    const fresh = await send('POST', '/token', undefined, { env: { ...TELNYX_ENV, TELNYX_SIP_CONNECTION_ID: 'sip-conn-2' } });
    expect(await fresh.json()).toEqual({ data: { token: 'jwt-new', configured: true, provider: 'telnyx' } });
  });

  it('fails when Telnyx refuses', async () => {
    telnyx.on('GET', '/telephony_credentials', { data: [] });
    telnyx.on('POST', '/telephony_credentials', () => telnyxError(422, 'Bad connection'));
    const res = await send('POST', '/token', undefined, { env: TELNYX_ENV });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate Voice token' } });

    telnyx.on('GET', '/telephony_credentials', { data: [{ id: 'bad/id' }] });
    expect((await send('POST', '/token', undefined, { env: TELNYX_ENV })).status).toBe(500);
  });
});

describe('GET /stats', () => {
  it('counts every call', async () => {
    const res = await send('GET', '/stats');
    expect(await res.json()).toEqual({
      data: {
        totalCalls: 3,
        completedCalls: 1,
        totalDuration: 121,
        avgDuration: 61,
        inboundCalls: 1,
        outboundCalls: 2,
        recordedCalls: 1,
        totalCreditsConsumed: 6,
      },
    });
  });
});

describe('call transcriptions', () => {
  it('reads a transcription with its segments in order', async () => {
    const res = await send('GET', '/calls/vcall_ci_mine/transcription');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { segments: Array<Record<string, unknown>> } & Record<string, unknown> };
    expect(data).toMatchObject({ id: 'trans_ci_1', status: 'completed', confidence: 0.75 });
    expect(data.segments.map((s) => [s.id, s.start, s.end, s.speaker])).toEqual([
      ['seg_ci_1', 0, 1.5, 'Speaker 1'],
      ['seg_ci_2', 1.5, 2.25, 'Speaker 2'],
    ]);
    expect((await send('GET', '/calls/vcall_ci_bare/transcription')).status).toBe(404);
    expect((await send('GET', '/calls/vcall_missing/transcription')).status).toBe(404);
  });

  it('follows the call owner without activities:scope:all', async () => {
    const scoped = ['activities:read', 'activities:create'];
    const denied = await send('GET', '/calls/vcall_ci_theirs/transcription', undefined, { grants: scoped });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'You do not have access to this call' } });
    expect((await send('GET', '/calls/vcall_ci_theirs/transcription/status', undefined, { grants: scoped })).status).toBe(403);
    expect((await send('POST', '/calls/vcall_ci_theirs/transcription', {}, { grants: scoped })).status).toBe(403);
  });

  it('reports the status', async () => {
    const done = await send('GET', '/calls/vcall_ci_mine/transcription/status');
    expect(await done.json()).toEqual({
      data: {
        exists: true,
        id: 'trans_ci_1',
        status: 'completed',
        errorMessage: null,
        processingStartedAt: '2026-10-01T08:05:00.000Z',
        processingCompletedAt: '2026-10-01T08:06:00.000Z',
        wordCount: 2,
        speakerCount: 2,
      },
    });
    expect(await (await send('GET', '/calls/vcall_ci_bare/transcription/status')).json()).toEqual({ data: { exists: false } });
    expect((await send('GET', '/calls/vcall_missing/transcription/status')).status).toBe(404);
  });

  it('starts one transcription per call', async () => {
    expect((await send('POST', '/calls/vcall_missing/transcription', {})).status).toBe(404);
    const created = await send('POST', '/calls/vcall_ci_bare/transcription', { language: 'nl' });
    expect(created.status).toBe(201);
    const conflict = await send('POST', '/calls/vcall_ci_bare/transcription');
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: 'CONFLICT', message: 'Transcription already exists for this call' } });
    expect((await send('POST', '/calls/vcall_ci_bare/transcription', { language: 7 })).status).toBe(400);
    const status = (await (await send('GET', '/calls/vcall_ci_bare/transcription/status')).json()) as { data: Record<string, unknown> };
    expect(status.data).toMatchObject({ exists: true, status: 'pending' });
  });
});
