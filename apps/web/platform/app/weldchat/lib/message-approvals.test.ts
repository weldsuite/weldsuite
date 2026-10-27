import { describe, expect, it } from 'vitest';
import {
  approvalCardState,
  FRESH_APPROVAL_MS,
  readMessageApprovals,
  type MessageApproval,
} from './message-approvals';

const pending: MessageApproval = { id: 'apr_1', label: 'Create task "QA"', status: 'pending' };
const NOW = Date.parse('2026-10-27T12:00:00Z');
const OLD = new Date(NOW - FRESH_APPROVAL_MS - 1).toISOString();
const YOUNG = new Date(NOW - 5_000).toISOString();

describe('readMessageApprovals', () => {
  it('reads the approvals a message carries', () => {
    expect(readMessageApprovals({ approvals: [{ id: 'apr_1', label: 'Create task "QA"', status: 'pending' }] })).toEqual([pending]);
  });

  it('is empty when the field is missing or not an array', () => {
    expect(readMessageApprovals(null)).toEqual([]);
    expect(readMessageApprovals(undefined)).toEqual([]);
    expect(readMessageApprovals('x')).toEqual([]);
    expect(readMessageApprovals({})).toEqual([]);
    expect(readMessageApprovals({ approvals: 'nope' })).toEqual([]);
  });

  it('skips entries without an id, repeats of an id, and non-objects', () => {
    expect(
      readMessageApprovals({
        approvals: [null, 7, { label: 'no id' }, { id: '' }, { id: 'a', label: 'A' }, { id: 'a', label: 'again' }],
      }),
    ).toEqual([{ id: 'a', label: 'A', status: 'pending' }]);
  });

  it('defaults a missing label to empty text and a missing status to pending', () => {
    expect(readMessageApprovals({ approvals: [{ id: 'a' }] })).toEqual([{ id: 'a', label: '', status: 'pending' }]);
  });
});

describe('approvalCardState', () => {
  it('waits while the agent still lists it as pending', () => {
    expect(approvalCardState({ approval: pending, local: null, pending: new Set(['apr_1']), askedAt: OLD, now: NOW })).toBe('waiting');
  });

  it('waits until the pending list has been read', () => {
    expect(approvalCardState({ approval: pending, local: null, pending: null, askedAt: OLD, now: NOW })).toBe('waiting');
  });

  it('shows what this browser just did, whatever the lists say', () => {
    for (const local of ['approved', 'rejected', 'handled'] as const) {
      expect(approvalCardState({ approval: pending, local, pending: new Set(['apr_1']), askedAt: YOUNG, now: NOW })).toBe(local);
    }
  });

  it('says handled when it is no longer pending and not young', () => {
    expect(approvalCardState({ approval: pending, local: null, pending: new Set(), askedAt: OLD, now: NOW })).toBe('handled');
  });

  it('does not call a young approval handled from a list that may predate it', () => {
    expect(approvalCardState({ approval: pending, local: null, pending: new Set(), askedAt: YOUNG, now: NOW })).toBe('waiting');
  });

  it('follows a status written onto the message', () => {
    expect(approvalCardState({ approval: { ...pending, status: 'approved' }, local: null, pending: null, now: NOW })).toBe('approved');
    expect(approvalCardState({ approval: { ...pending, status: 'rejected' }, local: null, pending: null, now: NOW })).toBe('rejected');
    expect(approvalCardState({ approval: { ...pending, status: 'expired' }, local: null, pending: null, now: NOW })).toBe('handled');
  });
});
