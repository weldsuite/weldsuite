import { describe, expect, it } from 'vitest';
import { isLongSummary, runTrigger } from './run-labels';

describe('runTrigger', () => {
  it('names a test of a routine, not a manual run', () => {
    expect(runTrigger({ triggerType: 'manual', triggerData: { routineId: 'rtn_1', test: true } })).toBe('routineTest');
  });

  it('names a scheduled or event-driven routine run', () => {
    expect(runTrigger({ triggerType: 'event', triggerData: { routineId: 'rtn_1', schedule: true } })).toBe('routine');
  });

  it('keeps the plain trigger types', () => {
    expect(runTrigger({ triggerType: 'manual', triggerData: null })).toBe('manual');
    expect(runTrigger({ triggerType: 'event', triggerData: { entityType: 'ticket' } })).toBe('event');
    expect(runTrigger({ triggerType: 'chat', triggerData: {} })).toBe('chat');
  });

  it('has no label for a trigger it does not know', () => {
    expect(runTrigger({ triggerType: 'webhook', triggerData: null })).toBeNull();
    expect(runTrigger({ triggerType: null, triggerData: null })).toBeNull();
  });
});

describe('isLongSummary', () => {
  it('flags long or multi-line summaries', () => {
    expect(isLongSummary('Done.')).toBe(false);
    expect(isLongSummary('a'.repeat(200))).toBe(true);
    expect(isLongSummary('one\ntwo\nthree\nfour')).toBe(true);
  });
});
