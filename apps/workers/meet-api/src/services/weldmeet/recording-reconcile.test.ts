/**
 * Pull fallback for recordings whose RealtimeKit webhooks never arrived.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { type Database } from '@weldsuite/worker-kit/db';
import type { RecordingPart } from '@weldsuite/db/schema/meeting-sessions';
import { loadSession } from '@weldsuite/meet-domain/recordings';
import { fakeKv, fakeWorkflow, seedMeetingWithSession } from '../../test/fakes';

const state = vi.hoisted(() => ({ db: null as unknown as Database }));
const getRecordings = vi.hoisted(() => vi.fn());

vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  return { ...actual, getTenantDbForWorkspace: async () => state.db };
});
vi.mock('@weldsuite/cloudflare-realtime', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/cloudflare-realtime')>('@weldsuite/cloudflare-realtime');
  return { ...actual, getRecordings };
});
vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEventRaw: vi.fn(async () => undefined), publishEntityEvent: vi.fn() };
});

import {
  MISSING_RECORDING_ERROR,
  MISSING_RECORDING_GRACE_MS,
  needsRecordingReconcile,
  reconcileRecordingFromRtk,
} from './recording-reconcile';
import type { Env } from '../../types';

const ORG = 'org_reconcile';

function makeEnv() {
  const copy = fakeWorkflow();
  const kv = fakeKv();
  const env = { WORKSPACE_CACHE: kv, MEETING_RECORDING_COPY: copy } as unknown as Env;
  return { env, copy, kv };
}

async function session(id: string) {
  return (await loadSession(state.db, id))!;
}

beforeAll(async () => {
  state.db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  getRecordings.mockReset();
});

describe('needsRecordingReconcile', () => {
  it('only checks unfinished recordings that have a RealtimeKit meeting', () => {
    expect(needsRecordingReconcile({ recordingStatus: 'processing', status: 'ended', cfAppId: 'rtk' })).toBe(true);
    expect(needsRecordingReconcile({ recordingStatus: 'recording', status: 'ended', cfAppId: 'rtk' })).toBe(true);
    expect(needsRecordingReconcile({ recordingStatus: 'recording', status: 'active', cfAppId: 'rtk' })).toBe(false);
    expect(needsRecordingReconcile({ recordingStatus: 'ready', status: 'ended', cfAppId: 'rtk' })).toBe(false);
    expect(needsRecordingReconcile({ recordingStatus: 'processing', status: 'ended', cfAppId: null })).toBe(false);
  });
});

describe('reconcileRecordingFromRtk', () => {
  it('feeds an uploaded RealtimeKit recording through the webhook path and starts the copy', async () => {
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_r1',
      sessionId: 'msess_r1',
      session: { cfAppId: 'rtk_r1', recordingStatus: 'processing', endedAt: new Date() },
    });
    getRecordings.mockResolvedValue([
      { id: 'rec_r1', status: 'UPLOADED', file_size: 2048, recording_duration: 90, started_time: '2026-10-02T21:22:00.000Z', stopped_time: '2026-10-02T21:24:00.000Z' },
    ]);
    const { env, copy } = makeEnv();

    const after = await reconcileRecordingFromRtk(env, state.db, ORG, await session('msess_r1'));

    expect(getRecordings).toHaveBeenCalledWith(env, 'rtk_r1');
    expect(after.recordingParts).toEqual([
      expect.objectContaining({ rtkRecordingId: 'rec_r1', status: 'processing', sizeBytes: 2048, durationSeconds: 90 }),
    ]);
    expect(copy.created).toEqual([
      expect.objectContaining({ id: 'rec-rec_r1', params: expect.objectContaining({ orgId: ORG, sessionId: 'msess_r1', rtkRecordingId: 'rec_r1' }) }),
    ]);
  });

  it('asks RealtimeKit at most once per throttle window', async () => {
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_r2',
      sessionId: 'msess_r2',
      session: { cfAppId: 'rtk_r2', recordingStatus: 'processing', endedAt: new Date() },
    });
    getRecordings.mockResolvedValue([]);
    const { env } = makeEnv();

    await reconcileRecordingFromRtk(env, state.db, ORG, await session('msess_r2'));
    await reconcileRecordingFromRtk(env, state.db, ORG, await session('msess_r2'));

    expect(getRecordings).toHaveBeenCalledTimes(1);
  });

  it('marks the recording failed when RealtimeKit has none long after the session ended', async () => {
    const endedAt = new Date(Date.now() - MISSING_RECORDING_GRACE_MS - 60_000);
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_r3',
      sessionId: 'msess_r3',
      session: { cfAppId: 'rtk_r3', recordingStatus: 'processing', endedAt },
    });
    getRecordings.mockResolvedValue([]);
    const { env } = makeEnv();

    const after = await reconcileRecordingFromRtk(env, state.db, ORG, await session('msess_r3'));

    expect(after.recordingStatus).toBe('failed');
    expect(after.recordingError).toBe(MISSING_RECORDING_ERROR);
  });

  it('keeps waiting while the session ended only recently', async () => {
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_r4',
      sessionId: 'msess_r4',
      session: { cfAppId: 'rtk_r4', recordingStatus: 'processing', endedAt: new Date() },
    });
    getRecordings.mockResolvedValue([]);
    const { env } = makeEnv();

    const after = await reconcileRecordingFromRtk(env, state.db, ORG, await session('msess_r4'));

    expect(after.recordingStatus).toBe('processing');
  });

  it('does not replay a part whose copy already failed', async () => {
    const failed: RecordingPart = {
      rtkRecordingId: 'rec_r5',
      videoKey: null,
      audioKey: null,
      sizeBytes: null,
      durationSeconds: null,
      startedAt: null,
      stoppedAt: null,
      status: 'failed',
    };
    const processing: RecordingPart = { ...failed, rtkRecordingId: 'rec_r5b', status: 'processing' };
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_r5',
      sessionId: 'msess_r5',
      session: { cfAppId: 'rtk_r5', recordingStatus: 'processing', recordingParts: [failed, processing], endedAt: new Date() },
    });
    getRecordings.mockResolvedValue([
      { id: 'rec_r5', status: 'UPLOADED' },
      { id: 'rec_r5b', status: 'UPLOADED' },
    ]);
    const { env, copy } = makeEnv();

    await reconcileRecordingFromRtk(env, state.db, ORG, await session('msess_r5'));

    expect(copy.created.map((w) => w.id)).toEqual(['rec-rec_r5b']);
  });

  it('leaves the session untouched when RealtimeKit cannot be reached', async () => {
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_r6',
      sessionId: 'msess_r6',
      session: { cfAppId: 'rtk_r6', recordingStatus: 'processing', endedAt: new Date(0) },
    });
    getRecordings.mockRejectedValue(new Error('RealtimeKit 503'));
    const { env } = makeEnv();
    const before = await session('msess_r6');

    const after = await reconcileRecordingFromRtk(env, state.db, ORG, before);

    expect(after).toBe(before);
    expect((await session('msess_r6')).recordingStatus).toBe('processing');
  });
});
