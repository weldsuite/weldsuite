import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { BILL_DUE_DAYS, isBillDue, isOpenBill, isOpenInvoice, useFillFilteredList } from './list-views';

describe('open invoices and bills', () => {
  it('counts an invoice that still waits for its money, not a draft, a paid or a cancelled one', () => {
    for (const status of ['finalized', 'sent', 'partial', 'overdue']) expect(isOpenInvoice({ status })).toBe(true);
    for (const status of ['draft', 'paid', 'cancelled', 'uncollectible']) expect(isOpenInvoice({ status })).toBe(false);
  });

  it('counts a bill that still waits to be paid, not a draft, one awaiting approval or a paid one', () => {
    for (const status of ['approved', 'partial', 'overdue']) expect(isOpenBill({ status })).toBe(true);
    for (const status of ['draft', 'pending_approval', 'paid', 'rejected', 'void']) expect(isOpenBill({ status })).toBe(false);
  });
});

describe('isBillDue', () => {
  const today = '2026-11-27';

  it('counts an overdue bill whatever its date says', () => {
    expect(isBillDue({ status: 'overdue', dueDate: null }, today)).toBe(true);
    expect(isBillDue({ status: 'overdue', dueDate: '2026-01-01' }, today)).toBe(true);
  });

  it('counts an open bill due within a week, the last day included', () => {
    expect(BILL_DUE_DAYS).toBe(7);
    expect(isBillDue({ status: 'approved', dueDate: '2026-11-27' }, today)).toBe(true);
    expect(isBillDue({ status: 'approved', dueDate: '2026-12-04' }, today)).toBe(true);
    expect(isBillDue({ status: 'approved', dueDate: '2026-12-05' }, today)).toBe(false);
  });

  it('counts a past-due open bill whose status has not caught up', () => {
    expect(isBillDue({ status: 'partial', dueDate: '2026-11-01T00:00:00.000Z' }, today)).toBe(true);
  });

  it('leaves out bills that are not open, and open ones without a date', () => {
    expect(isBillDue({ status: 'paid', dueDate: '2026-11-28' }, today)).toBe(false);
    expect(isBillDue({ status: 'draft', dueDate: '2026-11-28' }, today)).toBe(false);
    expect(isBillDue({ status: 'approved', dueDate: null }, today)).toBe(false);
  });

  it('crosses a month and a year end', () => {
    expect(isBillDue({ status: 'approved', dueDate: '2027-01-03' }, '2026-12-28')).toBe(true);
    expect(isBillDue({ status: 'approved', dueDate: '2027-01-05' }, '2026-12-28')).toBe(false);
  });
});

describe('useFillFilteredList', () => {
  const options = (overrides: Partial<Parameters<typeof useFillFilteredList>[0]> = {}) => ({
    active: true,
    shown: 2,
    hasMore: true,
    isLoadingMore: false,
    loadMore: vi.fn(),
    ...overrides,
  });

  it('asks for the next page while a narrowed view has fewer rows than a page', () => {
    const o = options();
    renderHook(() => useFillFilteredList(o));
    expect(o.loadMore).toHaveBeenCalledTimes(1);
  });

  it('stops once the view has enough rows, the list ends, a page is loading or the view is not narrowed', () => {
    for (const override of [{ shown: 25 }, { hasMore: false }, { isLoadingMore: true }, { active: false }]) {
      const o = options(override);
      renderHook(() => useFillFilteredList(o));
      expect(o.loadMore).not.toHaveBeenCalled();
    }
  });
});
