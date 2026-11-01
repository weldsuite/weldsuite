/**
 * /api/transcriptions against a real schema (pglite): CRM call and meeting
 * transcripts, their segments, and the owner scope (`activities:scope:all`
 * sees every transcript; without it only the activity's owner does).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { transcriptionsRoutes } from './index';
import type { Env, Variables } from '../../types';

const ME = 'user_test_default';
const OTHER = 'user_other_owner';
const ALL = ['activities:read', 'activities:create', 'activities:update', 'activities:delete'];

let db: Database;
let events: Array<{ entityType: string; action: string; entityId: string; data: Record<string, unknown> }> = [];
const eventsBinding = {
  send: async (message: (typeof events)[number]) => {
    events.push(message);
  },
  sendBatch: async (messages: Array<{ body: (typeof events)[number] }>) => {
    for (const message of messages) events.push(message.body);
  },
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.crmActivities).values([
    { id: 'act_mine', type: 'call', subject: 'My call', assignedToId: ME },
    { id: 'act_theirs', type: 'call', subject: 'Their call', assignedToId: OTHER },
    { id: 'act_fresh', type: 'meeting', subject: 'No transcript yet', assignedToId: ME },
    { id: 'act_fresh_theirs', type: 'meeting', subject: 'Theirs, no transcript', assignedToId: OTHER },
    { id: 'act_deleted', type: 'call', subject: 'Deleted', assignedToId: ME, deletedAt: new Date() },
  ]);
  await db.insert(schema.voipCalls).values({ id: 'call_voip', userId: ME, direction: 'outbound', fromNumber: '+3200', toNumber: '+3201' });
  await db.insert(schema.meetingBotSessions).values({
    id: 'mbs_bot',
    userId: OTHER,
    meetingUrl: 'https://meet.example.com/x',
    platform: 'zoom',
    name: 'Bot',
    serviceUrl: 'https://bot.example.com',
  });
  await db.insert(schema.meetings).values({ id: 'mtg_trans', title: 'Meeting', organizerId: ME, status: 'completed' });
  await db.insert(schema.meetingSessions).values({ id: 'msess_trans', meetingId: 'mtg_trans', status: 'ended', startedBy: ME, startedByName: 'Me' });
  await db.insert(schema.crmTranscriptions).values([
    { id: 'trans_mine', activityId: 'act_mine', status: 'completed', fullText: 'hello there', wordCount: 2, speakerCount: 2 },
    { id: 'trans_theirs', activityId: 'act_theirs', status: 'processing' },
    { id: 'trans_voip', activityId: 'call_voip', status: 'completed' },
    { id: 'trans_bot', activityId: 'mbs_bot', status: 'completed' },
    { id: 'trans_session', activityId: 'msess_trans', status: 'completed' },
    { id: 'trans_meeting', activityId: 'mtg_trans', status: 'completed' },
    { id: 'trans_orphan', activityId: 'act_gone_forever', status: 'failed', errorMessage: 'boom' },
  ]);
  await db.insert(schema.crmTranscriptSegments).values([
    { id: 'seg_2', transcriptionId: 'trans_mine', speakerId: 1, speakerLabel: 'Bea', text: 'there', startTime: 1.5, endTime: 2, sequenceNumber: 1 },
    { id: 'seg_1', transcriptionId: 'trans_mine', speakerId: 0, speakerLabel: 'Al', text: 'hello', startTime: 0, endTime: 1.5, sequenceNumber: 0 },
  ]);
}, 60_000);

beforeEach(() => {
  events = [];
});

/** `scoped`: without `activities:scope:all`, so only the owner's transcripts. */
function app(perms: string[] = ALL, scoped = false) {
  return createTestApp<Env, Variables>('/api/transcriptions', transcriptionsRoutes, {
    context: { permissions: permissions(...perms, ...(scoped ? [] : ['activities:scope:all'])), userId: ME, tenantDb: db },
    env: { ENTITY_EVENTS: eventsBinding } as unknown as Partial<Env>,
  });
}

const json = { 'Content-Type': 'application/json' };
type Transcript = { data: { id: string; segments: Array<{ id: string; speaker: string; start: number; end: number }> } };

describe('reads', () => {
  it('returns a transcript with its segments in order, by id and by activity', async () => {
    const { request } = app();
    const byId = (await (await request('/api/transcriptions/trans_mine')).json()) as Transcript;
    expect(byId.data).toMatchObject({ id: 'trans_mine', activityId: 'act_mine', fullText: 'hello there' });
    expect(byId.data.segments.map((s) => [s.id, s.speaker, s.start, s.end])).toEqual([
      ['seg_1', 'Al', 0, 1.5],
      ['seg_2', 'Bea', 1.5, 2],
    ]);
    const byActivity = (await (await request('/api/transcriptions/by-activity/act_mine')).json()) as Transcript;
    expect(byActivity.data.id).toBe('trans_mine');
    expect(byActivity.data.segments).toHaveLength(2);

    const segments = (await (await request('/api/transcriptions/trans_mine/segments')).json()) as { data: Array<{ id: string }> };
    expect(segments.data.map((s) => s.id)).toEqual(['seg_1', 'seg_2']);

    expect((await request('/api/transcriptions/trans_nope')).status).toBe(404);
    expect((await request('/api/transcriptions/by-activity/act_fresh')).status).toBe(404);
    expect((await request('/api/transcriptions/trans_nope/segments')).status).toBe(404);
  });

  it('reports the status by activity', async () => {
    const { request } = app();
    const exists = await request('/api/transcriptions/by-activity/act_mine/status');
    expect(((await exists.json()) as { data: unknown }).data).toMatchObject({ exists: true, id: 'trans_mine', status: 'completed', wordCount: 2, speakerCount: 2 });
    const none = await request('/api/transcriptions/by-activity/act_fresh/status');
    expect(await none.json()).toEqual({ data: { exists: false } });
  });

  it("limits a scoped member to the transcripts of what they own, whatever the activity's kind", async () => {
    const { request } = app(['activities:read'], true);
    expect((await request('/api/transcriptions/trans_mine')).status).toBe(200);
    expect((await request('/api/transcriptions/trans_voip')).status).toBe(200);
    expect((await request('/api/transcriptions/trans_session')).status).toBe(200);
    expect((await request('/api/transcriptions/trans_meeting')).status).toBe(200);
    expect((await request('/api/transcriptions/trans_theirs')).status).toBe(403);
    expect((await request('/api/transcriptions/trans_bot')).status).toBe(403);
    expect((await request('/api/transcriptions/trans_orphan')).status).toBe(403);
    expect((await request('/api/transcriptions/by-activity/act_theirs')).status).toBe(403);
    expect((await request('/api/transcriptions/by-activity/act_theirs/status')).status).toBe(403);
    expect((await request('/api/transcriptions/trans_theirs/segments')).status).toBe(403);
    expect((await app(['activities:create']).request('/api/transcriptions/trans_mine')).status).toBe(403);
  });
});

describe('writes', () => {
  it('creates a pending transcript once per activity', async () => {
    const { request } = app();
    const post = (body: unknown) => request('/api/transcriptions', { method: 'POST', headers: json, body: JSON.stringify(body) });

    const res = await post({ activityId: 'act_fresh', language: 'nl' });
    expect(res.status).toBe(201);
    const { id } = ((await res.json()) as { data: { id: string } }).data;
    expect(id).toMatch(/^trans_/);
    const [row] = await db.select().from(schema.crmTranscriptions).where(eq(schema.crmTranscriptions.id, id));
    expect(row).toMatchObject({ activityId: 'act_fresh', status: 'pending', language: 'nl' });
    expect(events).toContainEqual(
      expect.objectContaining({ entityType: 'transcription', action: 'created', data: { id: expect.stringMatching(/^trans_/), activityId: 'act_fresh', status: 'pending', language: 'nl' } }),
    );

    expect((await post({ activityId: 'act_fresh' })).status).toBe(409);
    expect((await post({ activityId: 'act_deleted' })).status).toBe(404);
    expect((await post({ activityId: 'act_unknown' })).status).toBe(404);
    expect((await post({})).status).toBe(400);
    const scoped = app(['activities:create'], true);
    expect((await scoped.request('/api/transcriptions', { method: 'POST', headers: json, body: '{"activityId":"act_fresh_theirs"}' })).status).toBe(403);
    expect((await app(['activities:read']).request('/api/transcriptions', { method: 'POST', headers: json, body: '{}' })).status).toBe(403);
  });

  it('updates a transcript, its dates parsed and cleared', async () => {
    await db.insert(schema.crmTranscriptions).values({ id: 'trans_upd', activityId: 'act_upd_owner_less', status: 'pending' });
    const { request } = app();
    const res = await request('/api/transcriptions/trans_upd', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({
        status: 'completed',
        fullText: 'done',
        wordCount: 1,
        processingStartedAt: '2026-06-01T10:00:00.000Z',
        processingCompletedAt: null,
        metadata: { source: 'test' },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'trans_upd' } });
    const [row] = await db.select().from(schema.crmTranscriptions).where(eq(schema.crmTranscriptions.id, 'trans_upd'));
    expect(row).toMatchObject({ status: 'completed', fullText: 'done', wordCount: 1, processingCompletedAt: null, metadata: { source: 'test' } });
    expect(row?.processingStartedAt?.toISOString()).toBe('2026-06-01T10:00:00.000Z');
    expect(events).toContainEqual(expect.objectContaining({ entityType: 'transcription', action: 'updated', data: { id: 'trans_upd' } }));

    expect((await request('/api/transcriptions/trans_nope', { method: 'PATCH', headers: json, body: '{}' })).status).toBe(404);
    expect((await request('/api/transcriptions/trans_upd', { method: 'PATCH', headers: json, body: '{"wordCount":"many"}' })).status).toBe(400);
    const scoped = app(['activities:update'], true);
    expect((await scoped.request('/api/transcriptions/trans_theirs', { method: 'PATCH', headers: json, body: '{}' })).status).toBe(403);
  });

  it('adds segments, deletes them, and deletes a transcript with its segments', async () => {
    await db.insert(schema.crmTranscriptions).values({ id: 'trans_seg', activityId: 'act_mine_two', status: 'completed' });
    const { request } = app();
    const added = await request('/api/transcriptions/trans_seg/segments', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        segments: [
          { speakerId: 0, text: 'one', startTime: 0, endTime: 1, sequenceNumber: 0 },
          { speakerId: 1, speakerLabel: 'Guest', speakerName: 'Gus', text: 'two', startTime: 1, endTime: 2, confidence: 0.9, sequenceNumber: 1 },
        ],
      }),
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toEqual({ data: { count: 2 } });
    const rows = await db.select().from(schema.crmTranscriptSegments).where(eq(schema.crmTranscriptSegments.transcriptionId, 'trans_seg'));
    expect(rows.map((r) => r.speakerLabel).sort()).toEqual(['Guest', 'Speaker 1']);

    expect((await request('/api/transcriptions/trans_nope/segments', { method: 'POST', headers: json, body: '{"segments":[]}' })).status).toBe(404);
    expect((await request('/api/transcriptions/trans_seg/segments', { method: 'POST', headers: json, body: '{"segments":[{"text":"x"}]}' })).status).toBe(400);

    expect((await request('/api/transcriptions/trans_seg/segments', { method: 'DELETE' })).status).toBe(204);
    expect(await db.select().from(schema.crmTranscriptSegments).where(eq(schema.crmTranscriptSegments.transcriptionId, 'trans_seg'))).toHaveLength(0);
    expect((await request('/api/transcriptions/trans_nope/segments', { method: 'DELETE' })).status).toBe(404);

    expect((await request('/api/transcriptions/trans_mine', { method: 'DELETE' })).status).toBe(204);
    expect(await db.select().from(schema.crmTranscriptions).where(eq(schema.crmTranscriptions.id, 'trans_mine'))).toHaveLength(0);
    expect(await db.select().from(schema.crmTranscriptSegments).where(eq(schema.crmTranscriptSegments.transcriptionId, 'trans_mine'))).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ entityType: 'transcription', action: 'deleted', entityId: 'trans_mine' }));
    expect((await request('/api/transcriptions/trans_mine', { method: 'DELETE' })).status).toBe(404);

    const scoped = app(['activities:delete', 'activities:create'], true);
    expect((await scoped.request('/api/transcriptions/trans_theirs', { method: 'DELETE' })).status).toBe(403);
    expect((await scoped.request('/api/transcriptions/trans_theirs/segments', { method: 'DELETE' })).status).toBe(403);
    expect((await scoped.request('/api/transcriptions/trans_theirs/segments', { method: 'POST', headers: json, body: '{"segments":[]}' })).status).toBe(403);
  });
});
