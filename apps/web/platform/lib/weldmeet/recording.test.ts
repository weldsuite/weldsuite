import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import {
  billableRecordingSeconds,
  billedMinutes,
  estimateCredits,
  hasApiStatus,
  isDeletableRecordingStatus,
  parseInsufficientCredits,
} from './recording';

describe('parseInsufficientCredits', () => {
  it('reads the details of a 402 from meet-api', () => {
    const err = new ApiError('Insufficient credits. Top up your workspace balance to continue.', 402, {
      error: {
        code: 'INSUFFICIENT_CREDITS',
        details: { currentBalance: 1, required: 3, shortfall: 2 },
      },
    });
    expect(parseInsufficientCredits(err)).toEqual({ currentBalance: 1, required: 3, shortfall: 2 });
  });

  it('returns empty details for a 402 without a body', () => {
    expect(parseInsufficientCredits(new ApiError('nope', 402))).toEqual({});
  });

  it('ignores other statuses and non-API errors', () => {
    expect(parseInsufficientCredits(new ApiError('conflict', 409))).toBeNull();
    expect(parseInsufficientCredits(new Error('boom'))).toBeNull();
    expect(parseInsufficientCredits(null)).toBeNull();
  });
});

describe('hasApiStatus', () => {
  it('matches the HTTP status of an ApiError only', () => {
    expect(hasApiStatus(new ApiError('x', 409), 409)).toBe(true);
    expect(hasApiStatus(new ApiError('x', 404), 409)).toBe(false);
    expect(hasApiStatus(new Error('x'), 409)).toBe(false);
  });
});

describe('credit estimate', () => {
  it('bills every started minute', () => {
    expect(billedMinutes(0)).toBe(0);
    expect(billedMinutes(null)).toBe(0);
    expect(billedMinutes(1)).toBe(1);
    expect(billedMinutes(60)).toBe(1);
    expect(billedMinutes(61)).toBe(2);
  });

  it('rounds the total up to whole credits', () => {
    expect(estimateCredits(10, 2)).toBe(20);
    expect(estimateCredits(3, 0.5)).toBe(2);
    expect(estimateCredits(0, 2)).toBe(0);
    expect(estimateCredits(5, 0)).toBe(0);
  });

  it('sums ready parts and caps at the session duration', () => {
    const parts = [
      { rtkRecordingId: 'a', status: 'ready', hasVideo: true, hasAudio: true, sizeBytes: 1, durationSeconds: 600, startedAt: null, stoppedAt: null },
      { rtkRecordingId: 'b', status: 'ready', hasVideo: true, hasAudio: true, sizeBytes: 1, durationSeconds: 300, startedAt: null, stoppedAt: null },
      { rtkRecordingId: 'c', status: 'failed', hasVideo: false, hasAudio: false, sizeBytes: null, durationSeconds: 900, startedAt: null, stoppedAt: null },
    ] as const;
    expect(billableRecordingSeconds({ parts: [...parts] })).toBe(900);
    expect(billableRecordingSeconds({ parts: [...parts], sessionDurationSeconds: 700 })).toBe(700);
    expect(billableRecordingSeconds({ durationSeconds: 120 })).toBe(120);
  });
});

describe('isDeletableRecordingStatus', () => {
  it('refuses while recording and when there is nothing to delete', () => {
    expect(isDeletableRecordingStatus('recording')).toBe(false);
    expect(isDeletableRecordingStatus('deleted')).toBe(false);
    expect(isDeletableRecordingStatus(null)).toBe(false);
    expect(isDeletableRecordingStatus('ready')).toBe(true);
  });
});
