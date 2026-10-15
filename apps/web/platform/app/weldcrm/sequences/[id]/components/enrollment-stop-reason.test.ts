import { describe, it, expect } from 'vitest';
import { getSendingLimitedVariant } from './enrollment-stop-reason';

describe('getSendingLimitedVariant', () => {
  it('reads the reason from stopReason', () => {
    expect(getSendingLimitedVariant({ status: 'paused', stopReason: 'sending_limited' })).toBe('paused');
  });

  it('reads it from errorMessage too, in any case and inside a longer message', () => {
    expect(getSendingLimitedVariant({ status: 'paused', errorMessage: 'sending_limited' })).toBe('paused');
    expect(
      getSendingLimitedVariant({ status: 'failed', errorMessage: 'Step "Intro" failed: SENDING_LIMITED (day)' }),
    ).toBe('stopped');
  });

  it('says an active or pending person is waiting for the limit', () => {
    expect(getSendingLimitedVariant({ status: 'active', stopReason: 'sending_limited' })).toBe('waiting');
    expect(getSendingLimitedVariant({ status: 'pending', stopReason: 'sending_limited' })).toBe('waiting');
  });

  it('is null without the reason', () => {
    expect(getSendingLimitedVariant({ status: 'paused' })).toBeNull();
    expect(getSendingLimitedVariant({ status: 'paused', stopReason: null, errorMessage: null })).toBeNull();
    expect(getSendingLimitedVariant({ status: 'failed', errorMessage: 'SMTP refused the message' })).toBeNull();
    expect(getSendingLimitedVariant({ status: 'paused', stopReason: 'manual' })).toBeNull();
  });

  it('ignores people who are done', () => {
    expect(getSendingLimitedVariant({ status: 'completed', stopReason: 'sending_limited' })).toBeNull();
    expect(getSendingLimitedVariant({ status: 'unenrolled', errorMessage: 'sending_limited' })).toBeNull();
  });
});
