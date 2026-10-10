import { describe, expect, it } from 'vitest';
import { getCurrentStep, getEnrollmentActivity, getStepKind } from './enrollment-progress';

const delay = (seconds: number) => ({ id: 'd', type: 'delay', name: 'Delay', config: { seconds } });
const email = { id: 'e', type: 'send_email', name: 'Send email', config: {} };
const condition = { id: 'c', type: 'condition', name: 'Check', config: {} };

describe('getEnrollmentActivity', () => {
  it('says "waiting" for a sequence whose only step is a delay, not "Automated email" (the QA case)', () => {
    // enrolled and active; the run is sleeping in step 1 (index is recorded before the sleep)
    expect(getEnrollmentActivity([delay(3600)], 1)).toEqual({ kind: 'waiting', seconds: 3600 });
    // before the run has recorded anything
    expect(getEnrollmentActivity([delay(3600)], 0)).toEqual({ kind: 'waiting', seconds: 3600 });
  });

  it('is on the step after the last one reached', () => {
    expect(getEnrollmentActivity([email, delay(60)], 1)).toEqual({ kind: 'waiting', seconds: 60 });
    expect(getEnrollmentActivity([email, condition], 1)).toEqual({ kind: 'condition' });
    expect(getEnrollmentActivity([email, email], 0)).toEqual({ kind: 'email' });
  });

  it('stays in a delay it has reached even though a step follows it', () => {
    expect(getEnrollmentActivity([delay(120), email], 1)).toEqual({ kind: 'waiting', seconds: 120 });
  });

  it('names other steps and falls back to unknown without steps', () => {
    expect(getEnrollmentActivity([{ type: 'log_message', name: 'Log it' }], 0)).toEqual({ kind: 'step', name: 'Log it' });
    expect(getEnrollmentActivity([{ type: 'log_message' }], 0)).toEqual({ kind: 'step', name: '' });
    expect(getEnrollmentActivity([], 0)).toEqual({ kind: 'unknown' });
  });

  it('copes with a progress index past the end (the sequence lost steps since)', () => {
    expect(getEnrollmentActivity([email], 5)).toEqual({ kind: 'unknown' });
    expect(getCurrentStep([email], 1)).toEqual(email);
  });

  it('has no seconds for a delay that is not a number yet', () => {
    expect(getEnrollmentActivity([{ type: 'delay', config: { seconds: '{{variables.x}}' } }], 0)).toEqual({
      kind: 'waiting',
      seconds: 0,
    });
  });
});

describe('getStepKind', () => {
  it('classifies the three step types a sequence can hold', () => {
    expect(getStepKind(email)).toBe('email');
    expect(getStepKind(delay(1))).toBe('delay');
    expect(getStepKind(condition)).toBe('condition');
    expect(getStepKind({ type: 'http_request' })).toBe('other');
    expect(getStepKind(undefined)).toBe('other');
    expect(getStepKind('delay')).toBe('other');
  });
});
