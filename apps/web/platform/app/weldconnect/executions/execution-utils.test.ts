import { describe, expect, it } from 'vitest';
import {
  extractExecutionError,
  formatExecutionDuration,
  getExecutionDuration,
  getStepsProgress,
  normalizeExecutionStatus,
  shortExecutionId,
} from './execution-utils';

const NOW = new Date('2026-10-06T12:00:10.000Z').getTime();

describe('getExecutionDuration', () => {
  it('prefers the stored duration', () => {
    expect(getExecutionDuration({ status: 'completed', duration: 4200 }, NOW)).toBe(4200);
  });

  it('falls back to completedAt - startedAt when no duration was stored', () => {
    expect(
      getExecutionDuration(
        {
          status: 'failed',
          duration: 0,
          startedAt: '2026-10-06T12:00:00.000Z',
          completedAt: '2026-10-06T12:05:12.000Z',
        },
        NOW,
      ),
    ).toBe(312_000);
  });

  it('returns the elapsed time for a running run', () => {
    expect(
      getExecutionDuration({ status: 'running', startedAt: '2026-10-06T12:00:00.000Z' }, NOW),
    ).toBe(10_000);
  });

  it('returns null for a queued run and for runs without timestamps', () => {
    expect(getExecutionDuration({ status: 'queued', startedAt: null }, NOW)).toBeNull();
    expect(getExecutionDuration({ status: 'completed' }, NOW)).toBeNull();
  });
});

describe('formatExecutionDuration', () => {
  it('formats across the ms / s / m / h ranges', () => {
    expect(formatExecutionDuration(null)).toBe('—');
    expect(formatExecutionDuration(340)).toBe('340ms');
    expect(formatExecutionDuration(4200)).toBe('4.2s');
    expect(formatExecutionDuration(312_000)).toBe('5m 12s');
    expect(formatExecutionDuration(7_500_000)).toBe('2h 5m');
  });
});

describe('getStepsProgress', () => {
  it('treats a completed run as fully done', () => {
    expect(getStepsProgress({ status: 'completed', currentStepIndex: 0, totalSteps: 1 })).toEqual({
      completed: 1,
      total: 1,
    });
  });

  it('uses currentStepIndex as steps finished for other statuses, capped at the total', () => {
    expect(getStepsProgress({ status: 'failed', currentStepIndex: 1, totalSteps: 3 })).toEqual({
      completed: 1,
      total: 3,
    });
    expect(getStepsProgress({ status: 'running', currentStepIndex: 9, totalSteps: 3 })).toEqual({
      completed: 3,
      total: 3,
    });
  });
});

describe('shortExecutionId', () => {
  it('keeps the distinguishing tail of long ids', () => {
    expect(shortExecutionId('wex_muv5abcdefgh12345678')).toBe('…12345678');
    expect(shortExecutionId('wex_short')).toBe('wex_short');
  });
});

describe('normalizeExecutionStatus', () => {
  it('maps the legacy pending status to queued', () => {
    expect(normalizeExecutionStatus('pending')).toBe('queued');
    expect(normalizeExecutionStatus('failed')).toBe('failed');
  });
});

describe('extractExecutionError', () => {
  it('reads strings, objects and details', () => {
    expect(extractExecutionError(null)).toBeNull();
    expect(extractExecutionError('boom')).toEqual({ message: 'boom' });
    expect(extractExecutionError({ message: 'Email send failed', details: { status: 500 } })).toEqual({
      message: 'Email send failed',
      details: { status: 500 },
    });
    expect(extractExecutionError({ message: 'plain' })).toEqual({ message: 'plain' });
  });
});
