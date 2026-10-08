import { describe, expect, it } from 'vitest';
import { approvalStateOf, holdFixTarget, isBankDetailHold, isRunOpen, isUnreleasableHold, statusTone } from './payment-run-utils';

const base = {
  status: 'pending_approval' as const,
  requiredApprovals: 2,
  createdBy: 'user_maker',
  approvals: [] as Array<{ userId: string; at: string }>,
};
const at = '2026-10-08T10:00:00.000Z';

describe('approvalStateOf', () => {
  it('has nothing to approve unless the run waits for approval', () => {
    for (const status of ['draft', 'approved', 'exported', 'completed', 'cancelled'] as const) {
      expect(approvalStateOf({ ...base, status }, 'user_a', true)).toMatchObject({ action: 'none', enabled: false });
    }
  });

  it('needs permission to manage banking', () => {
    expect(approvalStateOf(base, 'user_a', false)).toMatchObject({ action: 'approve', enabled: false, note: 'needs_permission' });
    expect(approvalStateOf(base, null, true)).toMatchObject({ action: 'approve', enabled: false, note: 'needs_permission' });
  });

  it('lets the maker approve first on a two-approval run, with a note that a second person is still needed', () => {
    expect(approvalStateOf(base, 'user_maker', true)).toEqual({ action: 'approve', enabled: true, note: 'creator_first', remaining: 2 });
  });

  it('lets someone else approve without a note', () => {
    expect(approvalStateOf(base, 'user_a', true)).toEqual({ action: 'approve', enabled: true, note: null, remaining: 2 });
  });

  it('does not let the same person approve twice', () => {
    const run = { ...base, approvals: [{ userId: 'user_maker', at }] };
    expect(approvalStateOf(run, 'user_maker', true)).toEqual({ action: 'approve', enabled: false, note: 'already_approved', remaining: 1 });
    expect(approvalStateOf(run, 'user_a', true)).toEqual({ action: 'approve', enabled: true, note: null, remaining: 1 });
  });

  it('lets the maker be the second approver after someone else', () => {
    const run = { ...base, approvals: [{ userId: 'user_a', at }] };
    expect(approvalStateOf(run, 'user_maker', true)).toMatchObject({ enabled: true, note: null, remaining: 1 });
  });

  it('does not single out the maker on a one-approval run', () => {
    expect(approvalStateOf({ ...base, requiredApprovals: 1 }, 'user_maker', true)).toMatchObject({ enabled: true, note: null });
  });

  it('offers to finish an interrupted approval when every approval is in', () => {
    const run = { ...base, approvals: [{ userId: 'user_a', at }, { userId: 'user_b', at }] };
    expect(approvalStateOf(run, 'user_a', true)).toEqual({ action: 'finish', enabled: true, note: 'finish', remaining: 0 });
    // Anyone who can manage banking may finish it, including someone who already approved.
    expect(approvalStateOf(run, 'user_c', true)).toMatchObject({ action: 'finish', enabled: true });
    expect(approvalStateOf(run, 'user_c', false)).toMatchObject({ action: 'finish', enabled: false, note: 'needs_permission' });
  });
});

describe('run status helpers', () => {
  it('knows which runs can still be changed', () => {
    expect(isRunOpen('draft')).toBe(true);
    expect(isRunOpen('pending_approval')).toBe(true);
    expect(isRunOpen('approved')).toBe(false);
    expect(isRunOpen('completed')).toBe(false);
  });

  it('gives every status a badge', () => {
    for (const status of ['draft', 'pending_approval', 'approved', 'exported', 'completed', 'cancelled'] as const) {
      expect(statusTone(status)).toBeTruthy();
    }
  });

  it('tells bank detail holds from the ones that can be released', () => {
    expect(isBankDetailHold('bank_details_changed')).toBe(true);
    expect(isBankDetailHold('no_bank_details')).toBe(true);
    expect(isBankDetailHold('backup_withholding')).toBe(false);
    expect(isBankDetailHold('in_other_run')).toBe(false);
  });

  it('never releases a withholding hold either: the chart needs a Backup Withholding Payable account', () => {
    expect(isUnreleasableHold('backup_withholding')).toBe(true);
    expect(isUnreleasableHold('bank_details_changed')).toBe(true);
    expect(isUnreleasableHold('in_other_run')).toBe(false);
    expect(isUnreleasableHold('prenote_required')).toBe(false);
    expect(holdFixTarget('backup_withholding')).toBe('chart');
    expect(holdFixTarget('no_bank_details')).toBe('vendors');
  });
});
