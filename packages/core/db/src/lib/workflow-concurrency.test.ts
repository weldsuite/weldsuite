import { describe, it, expect } from 'vitest';
import { workflowConcurrencyLimit, ACTIVE_WORKFLOW_EXECUTION_STATUSES } from './workflow-concurrency';

describe('workflowConcurrencyLimit', () => {
  it('reads a positive integer', () => {
    expect(workflowConcurrencyLimit({ maxConcurrentRuns: 3 })).toBe(3);
  });

  it('floors a fractional value', () => {
    expect(workflowConcurrencyLimit({ maxConcurrentRuns: 3.7 })).toBe(3);
  });

  it('is unlimited (undefined) when unset', () => {
    expect(workflowConcurrencyLimit({})).toBeUndefined();
    expect(workflowConcurrencyLimit(null)).toBeUndefined();
    expect(workflowConcurrencyLimit(undefined)).toBeUndefined();
  });

  it('is unlimited for zero, negative or non-numeric values', () => {
    expect(workflowConcurrencyLimit({ maxConcurrentRuns: 0 })).toBeUndefined();
    expect(workflowConcurrencyLimit({ maxConcurrentRuns: -5 })).toBeUndefined();
    expect(workflowConcurrencyLimit({ maxConcurrentRuns: 'unlimited' })).toBeUndefined();
    expect(workflowConcurrencyLimit({ maxConcurrentRuns: Number.NaN })).toBeUndefined();
  });

  it('is unlimited for a non-object settings value', () => {
    expect(workflowConcurrencyLimit('nope')).toBeUndefined();
    expect(workflowConcurrencyLimit(42)).toBeUndefined();
  });
});

describe('ACTIVE_WORKFLOW_EXECUTION_STATUSES', () => {
  it('occupies a slot for queued, running and waiting_for_input only', () => {
    expect(ACTIVE_WORKFLOW_EXECUTION_STATUSES).toEqual(['queued', 'running', 'waiting_for_input']);
  });
});
