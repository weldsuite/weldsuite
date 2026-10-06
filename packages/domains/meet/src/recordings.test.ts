import { describe, expect, it } from 'vitest';
import {
  contentTypeForExtension,
  deriveRecordingStatus,
  extensionOf,
  mirrorLatestReadyPart,
  recordingObjectKey,
  recordingPatchFromParts,
  upsertRecordingPart,
  type RecordingPart,
} from './recordings';

const part = (over: Partial<RecordingPart>): RecordingPart => ({
  rtkRecordingId: 'rec_1',
  videoKey: null,
  audioKey: null,
  sizeBytes: null,
  durationSeconds: null,
  startedAt: '2026-10-02T10:00:00.000Z',
  stoppedAt: null,
  status: 'recording',
  ...over,
});

describe('keys', () => {
  it('lays objects out under org/session', () => {
    expect(recordingObjectKey('org_1', 'msess_1', 'rec_1', 'mp4')).toBe('org_1/msess_1/rec_1.mp4');
  });

  it('reads extensions from file names and URLs, with a fallback', () => {
    expect(extensionOf('recording.MP4', 'x')).toBe('mp4');
    expect(extensionOf('https://h/a/b.mp3?sig=1', 'x')).toBe('mp3');
    expect(extensionOf(undefined, 'mp4')).toBe('mp4');
    expect(contentTypeForExtension('mp3')).toBe('audio/mpeg');
    expect(contentTypeForExtension('weird')).toBe('application/octet-stream');
  });
});

describe('recording parts', () => {
  it('upserts by RTK recording id and orders by start time', () => {
    const a = part({ rtkRecordingId: 'a', startedAt: '2026-10-02T10:30:00.000Z' });
    const b = part({ rtkRecordingId: 'b', startedAt: '2026-10-02T10:00:00.000Z' });
    let parts = upsertRecordingPart(upsertRecordingPart(null, a), b);
    expect(parts.map((p) => p.rtkRecordingId)).toEqual(['b', 'a']);
    parts = upsertRecordingPart(parts, { ...a, status: 'ready', videoKey: 'k' });
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({ rtkRecordingId: 'a', status: 'ready', videoKey: 'k' });
  });

  it('derives the session status: recording > processing > ready > failed', () => {
    expect(deriveRecordingStatus(null)).toBeNull();
    expect(deriveRecordingStatus([part({ status: 'ready' }), part({ rtkRecordingId: 'x', status: 'recording' })])).toBe('recording');
    expect(deriveRecordingStatus([part({ status: 'ready' }), part({ rtkRecordingId: 'x', status: 'processing' })])).toBe('processing');
    expect(deriveRecordingStatus([part({ status: 'ready' }), part({ rtkRecordingId: 'x', status: 'failed' })])).toBe('ready');
    expect(deriveRecordingStatus([part({ status: 'failed' })])).toBe('failed');
  });

  it('mirrors the latest ready part into the flat columns', () => {
    const parts = [
      part({ rtkRecordingId: 'a', status: 'ready', videoKey: 'va', audioKey: 'aa', sizeBytes: 10, durationSeconds: 60 }),
      part({ rtkRecordingId: 'b', status: 'ready', videoKey: 'vb', audioKey: null, sizeBytes: 20, durationSeconds: 90, startedAt: '2026-10-02T11:00:00.000Z' }),
      part({ rtkRecordingId: 'c', status: 'processing', startedAt: '2026-10-02T12:00:00.000Z' }),
    ];
    expect(mirrorLatestReadyPart(parts)).toEqual({
      recordingRtkId: 'b',
      recordingVideoKey: 'vb',
      recordingAudioKey: null,
      recordingSizeBytes: 20,
      recordingDurationSeconds: 90,
    });
    expect(mirrorLatestReadyPart([]).recordingVideoKey).toBeNull();
  });

  it('stores whole seconds in the integer duration column, keeping the part exact', () => {
    // RealtimeKit reports e.g. 10.444; writing that to `recording_duration_seconds`
    // failed the update and marked a finished recording as failed.
    const parts = [part({ status: 'ready', videoKey: 'v', sizeBytes: 414805, durationSeconds: 10.444 })];
    const patch = recordingPatchFromParts(parts);
    expect(patch.recordingDurationSeconds).toBe(10);
    expect(patch.recordingParts[0]!.durationSeconds).toBe(10.444);
    expect(mirrorLatestReadyPart([part({ status: 'ready', durationSeconds: 89.5 })]).recordingDurationSeconds).toBe(90);
    expect(mirrorLatestReadyPart([part({ status: 'ready', durationSeconds: 0 })]).recordingDurationSeconds).toBe(0);
    expect(mirrorLatestReadyPart([part({ status: 'ready', durationSeconds: null })]).recordingDurationSeconds).toBeNull();
  });

  it('builds the full patch, flagging recordingEnabled only while recording', () => {
    const now = new Date('2026-10-02T12:00:00.000Z');
    const recording = recordingPatchFromParts([part({ status: 'recording' })], now);
    expect(recording).toMatchObject({ recordingStatus: 'recording', recordingEnabled: true });
    expect('recordingReadyAt' in recording).toBe(false);

    const ready = recordingPatchFromParts([part({ status: 'ready', videoKey: 'v' })], now);
    expect(ready).toMatchObject({ recordingStatus: 'ready', recordingEnabled: false, recordingReadyAt: now });
  });
});
