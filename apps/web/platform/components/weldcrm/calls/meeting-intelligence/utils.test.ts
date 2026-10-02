import { describe, it, expect } from 'vitest';
import { isTranscriptionInProgress, usableTranscription } from './utils';
import type { TranscriptionData } from './types';

const row = (status: string): TranscriptionData => ({ id: 'trans_1', status, segments: [] });

describe('isTranscriptionInProgress', () => {
  it('is true for pending and processing only', () => {
    expect(isTranscriptionInProgress('pending')).toBe(true);
    expect(isTranscriptionInProgress('processing')).toBe(true);
    expect(isTranscriptionInProgress('completed')).toBe(false);
    expect(isTranscriptionInProgress('failed')).toBe(false);
    expect(isTranscriptionInProgress(undefined)).toBe(false);
  });
});

describe('usableTranscription', () => {
  it('keeps a completed transcription', () => {
    const completed = row('completed');
    expect(usableTranscription(completed)).toBe(completed);
  });

  // TASK-734: a failed row counted as "has a transcription", which hid the
  // Transcribe button and showed a plain empty state after a reload.
  it('drops a failed transcription', () => {
    expect(usableTranscription(row('failed'))).toBeNull();
  });

  it('drops a transcription that is still running', () => {
    expect(usableTranscription(row('pending'))).toBeNull();
    expect(usableTranscription(row('processing'))).toBeNull();
  });

  it('handles a missing row', () => {
    expect(usableTranscription(null)).toBeNull();
    expect(usableTranscription(undefined)).toBeNull();
  });
});
