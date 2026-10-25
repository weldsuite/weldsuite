import type { HrLeaveBalance } from '@weldsuite/app-api-client/domains/weldhr';

import { balanceForStart, canCancelLeave, checkAllowance, sortRequests } from '../leave';

const TODAY = '2026-10-24';

function balance(overrides: Partial<HrLeaveBalance> = {}): HrLeaveBalance {
  return {
    leaveTypeId: 'lt_holiday',
    name: 'Holiday',
    color: null,
    isPaid: true,
    overAllowance: 'allow',
    allowance: 25,
    fullAllowance: 25,
    prorated: false,
    used: 20,
    pending: 2,
    remaining: 3,
    ...overrides,
  };
}

describe('sortRequests', () => {
  it('puts pending and upcoming first, soonest on top, then the past newest first', () => {
    const rows = [
      { id: 'past-old', status: 'approved' as const, startDate: '2026-01-05', endDate: '2026-01-09' },
      { id: 'next-month', status: 'approved' as const, startDate: '2026-11-20', endDate: '2026-11-21' },
      { id: 'pending-late', status: 'pending' as const, startDate: '2026-12-24', endDate: '2026-12-31' },
      { id: 'past-recent', status: 'rejected' as const, startDate: '2026-09-01', endDate: '2026-09-02' },
      { id: 'running', status: 'approved' as const, startDate: '2026-10-20', endDate: '2026-10-27' },
    ];
    expect(sortRequests(rows, TODAY).map((r) => r.id)).toEqual([
      'running',
      'next-month',
      'pending-late',
      'past-recent',
      'past-old',
    ]);
  });
});

describe('canCancelLeave', () => {
  it('follows hr-api: pending always, approved only before it starts', () => {
    expect(canCancelLeave({ status: 'pending', startDate: '2026-10-01', endDate: '2026-10-02' }, TODAY)).toBe(true);
    expect(canCancelLeave({ status: 'approved', startDate: '2026-10-25', endDate: '2026-10-26' }, TODAY)).toBe(true);
    expect(canCancelLeave({ status: 'approved', startDate: TODAY, endDate: '2026-10-26' }, TODAY)).toBe(false);
    expect(canCancelLeave({ status: 'rejected', startDate: '2026-11-01', endDate: '2026-11-02' }, TODAY)).toBe(false);
  });
});

describe('balanceForStart', () => {
  it('uses this year\'s balance only for leave that starts this year', () => {
    const balances = [balance()];
    expect(balanceForStart(balances, 'lt_holiday', '2026-12-28', TODAY)).toBe(balances[0]);
    // hr-api checks next year's leave against next year's allowance, which the app does not have.
    expect(balanceForStart(balances, 'lt_holiday', '2027-01-04', TODAY)).toBeUndefined();
    expect(balanceForStart(balances, 'lt_other', '2026-12-28', TODAY)).toBeUndefined();
  });
});

describe('checkAllowance', () => {
  it('passes when the request fits or the type has no limit', () => {
    expect(checkAllowance(balance(), 3)).toEqual({ kind: 'ok' });
    expect(checkAllowance(balance({ allowance: null, remaining: null }), 40)).toEqual({ kind: 'ok' });
    expect(checkAllowance(undefined, 5)).toEqual({ kind: 'ok' });
  });

  it('warns, or blocks when the leave type says so', () => {
    expect(checkAllowance(balance(), 4)).toEqual({ kind: 'over', remaining: 3, blocked: false });
    expect(checkAllowance(balance({ overAllowance: 'block', remaining: -1 }), 1)).toEqual({
      kind: 'over',
      remaining: 0,
      blocked: true,
    });
  });
});
