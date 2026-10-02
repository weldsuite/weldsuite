/**
 * The recording and AI workflows (hosted in meet-api, code in
 * @weldsuite/meet-domain) run end to end against pglite with a fake step
 * runner, a fake R2 bucket and stubbed network/AI/billing edges.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { RecordingPart } from '@weldsuite/db/schema/meeting-sessions';
import { fakeBucket, fakeWorkflow, seedMeetingWithSession } from './test/fakes';

const state = vi.hoisted(() => ({ db: null as unknown as Database }));

vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  return { ...actual, getTenantDbForWorkspace: async () => state.db };
});
vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEventRaw: vi.fn(async () => undefined) };
});
const ai = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
  generateText: vi.fn(),
}));
vi.mock('@weldsuite/ai', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/ai')>('@weldsuite/ai');
  return { ...actual, ...ai, createWeldAI: () => ({ model: () => 'summary-model' }) };
});
const billing = vi.hoisted(() => ({
  getMeetingAiPricing: vi.fn(),
  resolveMeetingMetering: vi.fn(),
  chargeMeetingAi: vi.fn(),
}));
vi.mock('@weldsuite/meet-domain/billing', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/meet-domain/billing')>('@weldsuite/meet-domain/billing');
  return { ...actual, ...billing };
});

import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { CopyMeetingRecordingWorkflow } from '@weldsuite/meet-domain/workflows/copy-meeting-recording';
import { MeetingAiWorkflow, WHISPER_CHUNK_BYTES, whisperLanguage } from '@weldsuite/meet-domain/workflows/meeting-ai';
import { BackfillLegacyRecordingsWorkflow } from '@weldsuite/meet-domain/workflows/backfill-legacy-recordings';
import { mp3DurationSeconds } from '@weldsuite/meet-domain/audio/mp3';

const ORG = 'org_wf';
const mockedRaw = publishEntityEventRaw as unknown as ReturnType<typeof vi.fn>;

/** Runs every step inline, once (no retries): enough to test the logic of a run. */
const step = {
  do: async (_name: string, a: unknown, b?: unknown) => (typeof a === 'function' ? a : (b as () => unknown))(),
  sleep: async () => undefined,
};

const jsonRes = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function rtkEnv(handler: (url: string, init?: RequestInit) => Response) {
  return {
    CF_ACCOUNT_ID: 'acct',
    CF_REALTIME_APP_ID: 'app',
    CF_REALTIME_APP_SECRET: 'secret',
    RTK_FETCH: async (input: unknown, init?: RequestInit) => handler(String(input), init),
  };
}

async function session(sessionId: string) {
  const [row] = await state.db.select().from(schema.meetingSessions).where(eq(schema.meetingSessions.id, sessionId));
  return row!;
}

async function transcription(sessionId: string) {
  const [row] = await state.db.select().from(schema.crmTranscriptions).where(eq(schema.crmTranscriptions.activityId, sessionId));
  return row;
}

type WorkflowClass = new (ctx: never, env: never) => { run: (event: never, step: never) => Promise<unknown> };

function run<P>(Workflow: WorkflowClass, env: unknown, payload: P) {
  const instance = new Workflow({} as never, env as never);
  return instance.run({ payload, timestamp: new Date(), instanceId: 'wf' } as never, step as never);
}

beforeAll(async () => {
  state.db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  billing.getMeetingAiPricing.mockResolvedValue({ transcriptionCreditsPerMinute: 2, summaryCreditsPerMinute: 1 });
  billing.resolveMeetingMetering.mockResolvedValue({ masterDb: {}, internalWsId: 'ws', userId: 'system' });
  billing.chargeMeetingAi.mockImplementation(async (_m: unknown, p: { minutes: number; ratePerMinute: number }) => ({
    credits: Math.ceil(p.minutes * p.ratePerMinute),
    duplicate: false,
    settledNegative: false,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ----------------------------------------------------------------------------
// CopyMeetingRecordingWorkflow
// ----------------------------------------------------------------------------

describe('CopyMeetingRecordingWorkflow', () => {
  const processingPart = (id: string): RecordingPart => ({
    rtkRecordingId: id,
    videoKey: null,
    audioKey: null,
    sizeBytes: null,
    durationSeconds: null,
    startedAt: '2026-10-02T10:00:00.000Z',
    stoppedAt: '2026-10-02T10:10:00.000Z',
    status: 'processing',
  });

  const recordingBody = (extra: Record<string, unknown> = {}) => ({
    success: true,
    data: {
      id: 'rec_c1',
      status: 'UPLOADED',
      download_url: 'https://rtk.example/v.mp4?sig=1',
      audio_download_url: 'https://rtk.example/a.mp3?sig=1',
      download_url_expiry: null,
      file_size: 11,
      invoked_time: 'x',
      output_file_name: 'recording.mp4',
      session_id: 'rs',
      started_time: '2026-10-02T10:00:01.000Z',
      stopped_time: '2026-10-02T10:10:00.000Z',
      recording_duration: 599,
      ...extra,
    },
  });

  it('copies video and audio into the private bucket and flips the session to ready', async () => {
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_c1',
      sessionId: 'msess_c1',
      session: { recordingStatus: 'processing', recordingParts: [processingPart('rec_c1')] },
    });
    const bucket = fakeBucket();
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('v.mp4') ? new Response('video-bytes') : new Response('audio-bytes!'),
    );
    const env = { ...rtkEnv(() => jsonRes(recordingBody())), MEETING_RECORDINGS: bucket };

    await run(CopyMeetingRecordingWorkflow, env, {
      orgId: ORG,
      sessionId: 'msess_c1',
      rtkRecordingId: 'rec_c1',
    });

    expect([...bucket.objects.keys()].sort()).toEqual([`${ORG}/msess_c1/rec_c1.mp3`, `${ORG}/msess_c1/rec_c1.mp4`]);
    expect(new TextDecoder().decode(bucket.objects.get(`${ORG}/msess_c1/rec_c1.mp4`))).toBe('video-bytes');

    const row = await session('msess_c1');
    expect(row).toMatchObject({
      recordingStatus: 'ready',
      recordingEnabled: false,
      recordingRtkId: 'rec_c1',
      recordingVideoKey: `${ORG}/msess_c1/rec_c1.mp4`,
      recordingAudioKey: `${ORG}/msess_c1/rec_c1.mp3`,
      recordingSizeBytes: 11,
      recordingDurationSeconds: 599,
      recordingError: null,
    });
    expect(row.recordingReadyAt).toBeInstanceOf(Date);
    expect((row.recordingParts as RecordingPart[])[0]).toMatchObject({ status: 'ready', videoKey: row.recordingVideoKey });
    expect(mockedRaw).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'meeting_session', action: 'updated', entityId: 'msess_c1' }),
    );
  });

  it('keeps going without an audio file (no audio export)', async () => {
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_c2', sessionId: 'msess_c2', session: { recordingStatus: 'processing', recordingParts: [processingPart('rec_c2')] },
    });
    vi.stubGlobal('fetch', async () => new Response('video-bytes'));
    const env = { ...rtkEnv(() => jsonRes(recordingBody({ id: 'rec_c2', audio_download_url: null }))), MEETING_RECORDINGS: fakeBucket() };
    await run(CopyMeetingRecordingWorkflow, env, { orgId: ORG, sessionId: 'msess_c2', rtkRecordingId: 'rec_c2' });
    expect(await session('msess_c2')).toMatchObject({ recordingStatus: 'ready', recordingAudioKey: null });
  });

  it('records the failure on the session and rethrows when the download fails for good', async () => {
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_c3', sessionId: 'msess_c3', session: { recordingStatus: 'processing', recordingParts: [processingPart('rec_c3')] },
    });
    vi.stubGlobal('fetch', async () => new Response('forbidden', { status: 403 }));
    const env = { ...rtkEnv(() => jsonRes(recordingBody({ id: 'rec_c3' }))), MEETING_RECORDINGS: fakeBucket() };

    await expect(
      run(CopyMeetingRecordingWorkflow, env, { orgId: ORG, sessionId: 'msess_c3', rtkRecordingId: 'rec_c3' }),
    ).rejects.toThrow(/HTTP 403/);

    const row = await session('msess_c3');
    expect(row.recordingStatus).toBe('failed');
    expect(row.recordingError).toMatch(/HTTP 403/);
    expect((row.recordingParts as RecordingPart[])[0]!.status).toBe('failed');
  });

  it('resolves a fresh URL on every attempt (the webhook URL is never trusted)', async () => {
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_c4', sessionId: 'msess_c4', session: { recordingStatus: 'processing', recordingParts: [processingPart('rec_c4')] },
    });
    const rtkCalls: string[] = [];
    vi.stubGlobal('fetch', async () => new Response('x'));
    const env = {
      ...rtkEnv((url) => {
        rtkCalls.push(url);
        return jsonRes(recordingBody({ id: 'rec_c4' }));
      }),
      MEETING_RECORDINGS: fakeBucket(),
    };
    await run(CopyMeetingRecordingWorkflow, env, { orgId: ORG, sessionId: 'msess_c4', rtkRecordingId: 'rec_c4' });
    expect(rtkCalls.filter((u) => u.includes('/recordings/rec_c4')).length).toBeGreaterThanOrEqual(2);
  });
});

// ----------------------------------------------------------------------------
// MeetingAiWorkflow: RealtimeKit transcript / summary ingest
// ----------------------------------------------------------------------------

describe('MeetingAiWorkflow ingest-rtk-transcript', () => {
  const transcriptJson = JSON.stringify([
    { startTime: 1000, endTime: 2500, sentence: 'Hello everyone', peerData: { id: 'p1', userId: 'u1', displayName: 'Alice', cpi: 'c1' } },
    { startTime: 3000, endTime: 4500, sentence: 'Hi Alice', peerData: { id: 'p2', userId: 'u2', displayName: 'Bob', cpi: 'c2' } },
  ]);

  function transcriptEnv(bucket: ReturnType<typeof fakeBucket>, jsonAvailable = true) {
    return {
      ...rtkEnv((url) => {
        if (url.includes('/transcript') && jsonAvailable) {
          return jsonRes({ success: true, data: { sessionId: 's', transcript_download_url: 'https://rtk.example/t.json', transcript_download_url_expiry: 'e' } });
        }
        return new Response('nope', { status: 404 });
      }),
      MEETING_RECORDINGS: bucket,
    };
  }

  it('stores the raw file and speaker segments, then charges per meeting minute', async () => {
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_i1', sessionId: 'msess_i1', session: { duration: 1830, aiLanguage: 'nl' },
    });
    const bucket = fakeBucket();
    vi.stubGlobal('fetch', async (url: string) =>
      url === 'https://rtk.example/t.json' ? new Response(transcriptJson) : new Response('', { status: 404 }),
    );

    await run(MeetingAiWorkflow, transcriptEnv(bucket), {
      kind: 'ingest-rtk-transcript', orgId: ORG, sessionId: 'msess_i1', rtkSessionId: 'rs1', downloadUrl: 'https://rtk.example/t.csv',
    });

    expect(bucket.objects.has(`${ORG}/msess_i1/transcript.json`)).toBe(true);
    const row = await transcription('msess_i1');
    expect(row).toMatchObject({
      status: 'completed', provider: 'cloudflare-rtk', model: 'whisper-large-v3-turbo', language: 'nl', speakerCount: 2, wordCount: 4, fullText: 'Hello everyone Hi Alice',
    });
    expect(row!.metadata).toMatchObject({ source: 'rtk', rawKey: `${ORG}/msess_i1/transcript.json`, rtkSessionId: 'rs1' });
    const segments = await state.db.select().from(schema.crmTranscriptSegments).where(eq(schema.crmTranscriptSegments.transcriptionId, row!.id));
    expect(segments.map((s) => [s.speakerLabel, s.text, s.startTime, s.endTime])).toEqual([
      ['Alice', 'Hello everyone', 1, 2.5],
      ['Bob', 'Hi Alice', 3, 4.5],
    ]);

    // 1830 s = 31 started minutes at 2 credits.
    expect(billing.chargeMeetingAi).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'transcription', sessionId: 'msess_i1', minutes: 31, ratePerMinute: 2, source: 'rtk' }),
    );
    expect((await session('msess_i1')).transcriptionCreditsCharged).toBe(62);
  });

  it('falls back to the webhook CSV when the JSON URL is unavailable, and re-delivery keeps one transcript', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_i2', sessionId: 'msess_i2', session: { duration: 60 } });
    const bucket = fakeBucket();
    const csv = '"1000","p1","u1","c1","Alice","Hello"\n"2000","p2","u2","c2","Bob","Hi"';
    vi.stubGlobal('fetch', async () => new Response(csv));
    const env = transcriptEnv(bucket, false);
    const params = { kind: 'ingest-rtk-transcript', orgId: ORG, sessionId: 'msess_i2', rtkSessionId: 'rs2', downloadUrl: 'https://rtk.example/t.csv' } as const;

    await run(MeetingAiWorkflow, env, params);
    await run(MeetingAiWorkflow, env, params);

    expect(bucket.objects.has(`${ORG}/msess_i2/transcript.csv`)).toBe(true);
    const rows = await state.db.select().from(schema.crmTranscriptions).where(eq(schema.crmTranscriptions.activityId, 'msess_i2'));
    expect(rows).toHaveLength(1);
    const segments = await state.db.select().from(schema.crmTranscriptSegments).where(eq(schema.crmTranscriptSegments.transcriptionId, rows[0]!.id));
    expect(segments).toHaveLength(2);
  });

  it('still delivers the transcript when charging fails, and never charges a failed ingest', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_i3', sessionId: 'msess_i3', session: { duration: 60 } });
    const bucket = fakeBucket();
    vi.stubGlobal('fetch', async () => new Response(transcriptJson));
    billing.chargeMeetingAi.mockRejectedValue(new Error('master db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await run(MeetingAiWorkflow, transcriptEnv(bucket), {
      kind: 'ingest-rtk-transcript', orgId: ORG, sessionId: 'msess_i3', rtkSessionId: 'rs3', downloadUrl: null,
    });
    expect((await transcription('msess_i3'))!.status).toBe('completed');

    // No URL at all: the run fails, a failed transcription row records why, nothing is charged.
    await seedMeetingWithSession(state.db, { meetingId: 'meet_i4', sessionId: 'msess_i4', session: { duration: 60 } });
    billing.chargeMeetingAi.mockClear();
    await expect(
      run(MeetingAiWorkflow, transcriptEnv(bucket, false), { kind: 'ingest-rtk-transcript', orgId: ORG, sessionId: 'msess_i4', rtkSessionId: null, downloadUrl: null }),
    ).rejects.toThrow(/No transcript download URL/);
    expect(await transcription('msess_i4')).toMatchObject({ status: 'failed' });
    expect(billing.chargeMeetingAi).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('MeetingAiWorkflow ingest-rtk-summary', () => {
  it('stores the markdown on the session and charges the summary rate per meeting minute', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_u1', sessionId: 'msess_u1', session: { duration: 600 } });
    vi.stubGlobal('fetch', async () => new Response('## Summary\n- decided X'));

    await run(MeetingAiWorkflow, rtkEnv(() => new Response('', { status: 404 })), {
      kind: 'ingest-rtk-summary', orgId: ORG, sessionId: 'msess_u1', rtkSessionId: 'rs', downloadUrl: 'https://rtk.example/s.md',
    });

    expect(await session('msess_u1')).toMatchObject({
      summaryStatus: 'completed', summaryText: '## Summary\n- decided X', summaryFormat: 'markdown', summarySource: 'rtk', summaryCreditsCharged: 10,
    });
    expect(billing.chargeMeetingAi).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'summary', minutes: 10, ratePerMinute: 1, source: 'rtk' }),
    );
  });

  it('marks the summary failed when the download fails', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_u2', sessionId: 'msess_u2', session: { duration: 600 } });
    vi.stubGlobal('fetch', async () => new Response('gone', { status: 410 }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      run(MeetingAiWorkflow, rtkEnv(() => new Response('', { status: 404 })), {
        kind: 'ingest-rtk-summary', orgId: ORG, sessionId: 'msess_u2', rtkSessionId: null, downloadUrl: 'https://rtk.example/s.md',
      }),
    ).rejects.toThrow(/HTTP 410/);
    expect(await session('msess_u2')).toMatchObject({ summaryStatus: 'failed' });
    expect(billing.chargeMeetingAi).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

// ----------------------------------------------------------------------------
// MeetingAiWorkflow: Whisper over the stored audio
// ----------------------------------------------------------------------------

/** MPEG1 Layer III 128 kbps / 44.1 kHz frames of 417 bytes (1152 samples each). */
function mp3(frames: number): Uint8Array {
  const out = new Uint8Array(frames * 417);
  for (let i = 0; i < frames; i++) out.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  return out;
}

describe('MeetingAiWorkflow whisper-transcribe', () => {
  const readyPart = (id: string, sessionId: string, startedAt: string, durationSeconds: number): RecordingPart => ({
    rtkRecordingId: id,
    videoKey: `${ORG}/${sessionId}/${id}.mp4`,
    audioKey: `${ORG}/${sessionId}/${id}.mp3`,
    sizeBytes: 1,
    durationSeconds,
    startedAt,
    stoppedAt: null,
    status: 'ready',
  });

  it('transcribes every part in MP3-aligned chunks, offsets timestamps and bills the capped duration', async () => {
    // Part 1 spans two chunks (just over 4 MiB), part 2 is a short single chunk.
    const framesPart1 = Math.ceil(WHISPER_CHUNK_BYTES / 417) + 2000;
    const part1 = mp3(framesPart1);
    const part2 = mp3(400);
    const p1 = readyPart('rec_w1a', 'msess_w1', '2026-10-02T10:00:00.000Z', 300);
    const p2 = readyPart('rec_w1b', 'msess_w1', '2026-10-02T11:00:00.000Z', 20);
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_w1', sessionId: 'msess_w1',
      session: { duration: 310, recordingStatus: 'ready', recordingParts: [p1, p2], recordingAudioKey: p2.audioKey },
    });
    await state.db.insert(schema.crmTranscriptions).values({ id: 'trans_w1', activityId: 'msess_w1', status: 'pending' });
    const bucket = fakeBucket({ [p1.audioKey!]: part1, [p2.audioKey!]: part2 });

    const clips: number[] = [];
    ai.transcribeAudio.mockImplementation(async (_env: unknown, input: { audio: Uint8Array; language?: string }) => {
      clips.push(input.audio.length);
      expect(input.language).toBe('nl');
      return { text: 't', segments: [{ start: 1, end: 2, text: `chunk ${clips.length}` }], wordCount: 2, language: 'nl', modelId: 'm' };
    });

    await run(MeetingAiWorkflow, { MEETING_RECORDINGS: bucket }, {
      kind: 'whisper-transcribe', orgId: ORG, sessionId: 'msess_w1', transcriptionId: 'trans_w1', userId: 'user_1', language: 'nl-NL',
    });

    // Whole frames only, and the three clips tile the audio exactly.
    expect(clips).toHaveLength(3);
    expect(clips.every((n) => n % 417 === 0)).toBe(true);
    expect(clips.reduce((a, b) => a + b, 0)).toBe(part1.length + part2.length);

    const row = await transcription('msess_w1');
    expect(row).toMatchObject({ id: 'trans_w1', status: 'completed', provider: 'cloudflare-whisper', language: 'nl' });
    const segments = await state.db
      .select().from(schema.crmTranscriptSegments).where(eq(schema.crmTranscriptSegments.transcriptionId, 'trans_w1'));
    segments.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const firstChunkSeconds = mp3DurationSeconds(part1.subarray(0, clips[0]));
    const part1Seconds = mp3DurationSeconds(part1);
    expect(segments.map((s) => s.text)).toEqual(['chunk 1', 'chunk 2', 'chunk 3']);
    expect(segments[0]!.startTime).toBeCloseTo(1, 3);
    expect(segments[1]!.startTime).toBeCloseTo(firstChunkSeconds + 1, 2);
    // Part 2 starts where part 1's audio ended.
    expect(segments[2]!.startTime).toBeCloseTo(part1Seconds + 1, 2);
    expect(segments.every((s) => s.speakerId === 0)).toBe(true);

    // Summed part durations (300 + 20) capped at the session length (310 s) = 6 started minutes.
    expect(billing.chargeMeetingAi).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'transcription', minutes: 6, ratePerMinute: 2, source: 'whisper', runId: 'trans_w1' }),
    );
    expect((await session('msess_w1')).transcriptionCreditsCharged).toBe(12);
  });

  it('fails the transcription (and charges nothing) when the audio is not MP3', async () => {
    const p = readyPart('rec_w2', 'msess_w2', '2026-10-02T10:00:00.000Z', 60);
    await seedMeetingWithSession(state.db, {
      meetingId: 'meet_w2', sessionId: 'msess_w2', session: { recordingStatus: 'ready', recordingParts: [p], recordingAudioKey: p.audioKey },
    });
    await state.db.insert(schema.crmTranscriptions).values({ id: 'trans_w2', activityId: 'msess_w2', status: 'pending' });
    const bucket = fakeBucket({ [p.audioKey!]: new Uint8Array(2048) });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      run(MeetingAiWorkflow, { MEETING_RECORDINGS: bucket }, {
        kind: 'whisper-transcribe', orgId: ORG, sessionId: 'msess_w2', transcriptionId: 'trans_w2', userId: 'u',
      }),
    ).rejects.toThrow(/not MP3/);
    expect(await transcription('msess_w2')).toMatchObject({ status: 'failed' });
    expect(ai.transcribeAudio).not.toHaveBeenCalled();
    expect(billing.chargeMeetingAi).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('maps RealtimeKit-style codes to Whisper hints', () => {
    expect(whisperLanguage('en-US')).toBe('en');
    expect(whisperLanguage('nl')).toBe('nl');
    expect(whisperLanguage('auto')).toBeUndefined();
    expect(whisperLanguage(undefined)).toBeUndefined();
    expect(whisperLanguage('')).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// MeetingAiWorkflow: summarize
// ----------------------------------------------------------------------------

describe('MeetingAiWorkflow summarize', () => {
  async function seedTranscript(sessionId: string, transcriptionId: string) {
    await state.db.insert(schema.crmTranscriptions).values({ id: transcriptionId, activityId: sessionId, status: 'completed', fullText: 'x' });
    await state.db.insert(schema.crmTranscriptSegments).values({
      id: `seg_${transcriptionId}`, transcriptionId, speakerId: 0, speakerLabel: 'Alice', text: 'We ship on Friday', startTime: 5, endTime: 8, sequenceNumber: 0,
    });
  }

  it('summarizes the stored transcript with Workers AI and charges with the run id', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_z1', sessionId: 'msess_z1', session: { duration: 900 } });
    await seedTranscript('msess_z1', 'trans_z1');
    ai.generateText.mockResolvedValue({ text: '  ## Summary\nShip Friday.  ' });

    await run(MeetingAiWorkflow, {}, { kind: 'summarize', orgId: ORG, sessionId: 'msess_z1', userId: 'user_1', runId: 'run1' });

    const prompt = (ai.generateText.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain('[00:00:05] Alice: We ship on Friday');
    expect(await session('msess_z1')).toMatchObject({
      summaryStatus: 'completed', summaryText: '## Summary\nShip Friday.', summarySource: 'workers_ai', summaryFormat: 'markdown', summaryCreditsCharged: 15,
    });
    expect(billing.chargeMeetingAi).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'summary', minutes: 15, source: 'workers_ai', runId: 'run1' }),
    );
  });

  it('marks the summary failed when there is no completed transcript', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_z2', sessionId: 'msess_z2', session: { duration: 900 } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      run(MeetingAiWorkflow, {}, { kind: 'summarize', orgId: ORG, sessionId: 'msess_z2', userId: 'u', runId: 'r' }),
    ).rejects.toThrow(/no completed transcript/);
    expect(await session('msess_z2')).toMatchObject({ summaryStatus: 'failed' });
    expect(ai.generateText).not.toHaveBeenCalled();
    expect(billing.chargeMeetingAi).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

// ----------------------------------------------------------------------------
// BackfillLegacyRecordingsWorkflow
// ----------------------------------------------------------------------------

describe('BackfillLegacyRecordingsWorkflow', () => {
  const DAY = 24 * 60 * 60 * 1000;

  function rtkList(byMeeting: Record<string, unknown[] | { status: number }>) {
    return rtkEnv((url) => {
      const meetingId = new URL(url).searchParams.get('meeting_id') ?? '';
      const entry = byMeeting[meetingId];
      if (!entry) return jsonRes({ success: true, data: [] });
      if (!Array.isArray(entry)) return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'x' }] }), { status: entry.status, headers: { 'Content-Type': 'application/json' } });
      return jsonRes({ success: true, data: entry });
    });
  }

  const uploaded = (id: string) => ({
    id,
    status: 'UPLOADED',
    download_url: 'https://rtk.example/v.mp4',
    audio_download_url: null,
    download_url_expiry: new Date(Date.now() + DAY).toISOString(),
    file_size: 99,
    invoked_time: 'x',
    output_file_name: 'v.mp4',
    session_id: 'rtk_sess_bf',
    started_time: '2026-10-01T10:00:00.000Z',
    stopped_time: '2026-10-01T10:30:00.000Z',
    recording_duration: 1800,
  });

  const legacy = (over: Partial<typeof schema.meetingSessions.$inferInsert>) => ({
    recordingUrl: 'https://rtk.example/old.mp4',
    endedAt: new Date(Date.now() - DAY),
    ...over,
  });

  it('queues the copy of recordings RealtimeKit still has and marks the rest unavailable, then is a no-op on re-run', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_bf1', sessionId: 'msess_bf1', session: legacy({ cfAppId: 'rtk_bf1' }) });
    await seedMeetingWithSession(state.db, { meetingId: 'meet_bf2', sessionId: 'msess_bf2', session: legacy({ cfAppId: 'rtk_bf2', endedAt: new Date(Date.now() - 10 * DAY) }) });
    await seedMeetingWithSession(state.db, { meetingId: 'meet_bf3', sessionId: 'msess_bf3', session: legacy({ cfAppId: 'rtk_bf3' }) });
    await seedMeetingWithSession(state.db, { meetingId: 'meet_bf4', sessionId: 'msess_bf4', session: legacy({ cfAppId: 'rtk_bf4' }) });
    await seedMeetingWithSession(state.db, { meetingId: 'meet_bf5', sessionId: 'msess_bf5', session: legacy({ cfAppId: null, recordingUrl: null, recordingKey: 'rtk_x' }) });
    // Not candidates: already has a status, or never had a legacy marker.
    await seedMeetingWithSession(state.db, { meetingId: 'meet_bf6', sessionId: 'msess_bf6', session: legacy({ cfAppId: 'rtk_bf1', recordingStatus: 'ready' }) });
    await seedMeetingWithSession(state.db, { meetingId: 'meet_bf7', sessionId: 'msess_bf7', session: { cfAppId: 'rtk_bf1' } });

    const copy = fakeWorkflow();
    const requested: string[] = [];
    const base = rtkList({
      rtk_bf1: [uploaded('rec_bf1')],
      rtk_bf2: [uploaded('rec_bf2_old')],
      rtk_bf3: [{ ...uploaded('rec_bf3'), download_url_expiry: new Date(Date.now() - 1000).toISOString() }, { ...uploaded('rec_bf3b'), status: 'ERRORED' }],
      rtk_bf4: { status: 404 },
    });
    const env = {
      ...base,
      RTK_FETCH: async (input: unknown, init?: RequestInit) => {
        requested.push(new URL(String(input)).searchParams.get('meeting_id') ?? '');
        return base.RTK_FETCH(input, init);
      },
      MEETING_RECORDING_COPY: copy,
    };

    const result = await run(BackfillLegacyRecordingsWorkflow, env, { orgId: ORG });
    expect(result).toMatchObject({ queued: 1, unavailable: 4, skipped: 0, hasMore: false });

    const bf1 = await session('msess_bf1');
    expect(bf1).toMatchObject({ recordingStatus: 'processing', rtkSessionId: 'rtk_sess_bf' });
    expect((bf1.recordingParts as RecordingPart[])[0]).toMatchObject({ rtkRecordingId: 'rec_bf1', status: 'processing', durationSeconds: 1800, sizeBytes: 99 });
    expect(copy.created).toEqual([
      { id: 'rec-rec_bf1', params: { orgId: ORG, sessionId: 'msess_bf1', rtkRecordingId: 'rec_bf1', startedAt: '2026-10-01T10:00:00.000Z', stoppedAt: '2026-10-01T10:30:00.000Z', durationSeconds: 1800 } },
    ]);

    for (const id of ['msess_bf2', 'msess_bf3', 'msess_bf4', 'msess_bf5']) {
      expect((await session(id)).recordingStatus, id).toBe('unavailable');
    }
    // Older than RealtimeKit's retention: no API call at all. No cfAppId: none either.
    expect(requested).not.toContain('rtk_bf2');
    expect((await session('msess_bf6')).recordingStatus).toBe('ready');
    expect((await session('msess_bf7')).recordingStatus).toBeNull();
    expect(mockedRaw).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'msess_bf2', data: expect.objectContaining({ recordingStatus: 'unavailable' }) }));

    // Re-run: nothing is a candidate any more, nothing is dispatched twice.
    const again = await run(BackfillLegacyRecordingsWorkflow, env, { orgId: ORG });
    expect(again).toMatchObject({ queued: 0, unavailable: 0, skipped: 0 });
    expect(copy.created).toHaveLength(1);
  });

  it('treats an already-running copy instance as fine and retries (throws) on a transient RealtimeKit error', async () => {
    await seedMeetingWithSession(state.db, { meetingId: 'meet_bf8', sessionId: 'msess_bf8', session: legacy({ cfAppId: 'rtk_bf8' }) });
    const copy = fakeWorkflow({ failWith: new Error('instance.already_exists') });
    await run(BackfillLegacyRecordingsWorkflow, { ...rtkList({ rtk_bf8: [uploaded('rec_bf8')] }), MEETING_RECORDING_COPY: copy }, { orgId: ORG });
    expect((await session('msess_bf8')).recordingStatus).toBe('processing');

    await seedMeetingWithSession(state.db, { meetingId: 'meet_bf9', sessionId: 'msess_bf9', session: legacy({ cfAppId: 'rtk_bf9' }) });
    await expect(
      run(BackfillLegacyRecordingsWorkflow, { ...rtkList({ rtk_bf9: { status: 500 } }), MEETING_RECORDING_COPY: fakeWorkflow() }, { orgId: ORG }),
    ).rejects.toThrow(/500/);
    // Left untouched so the retry (or the next run) picks it up again.
    expect((await session('msess_bf9')).recordingStatus).toBeNull();
  });
});
