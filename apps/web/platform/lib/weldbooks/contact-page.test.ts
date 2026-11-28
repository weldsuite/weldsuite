import { describe, expect, it } from 'vitest';
import { countOf, describeSums, nonZero, reminderLevel, timelineTone } from './contact-page';

const money = (value: number | string | null | undefined, currency?: string | null) =>
  `${currency ?? 'EUR'} ${Number(value ?? 0).toFixed(2)}`;

describe('amounts per currency', () => {
  it('leaves out a currency at zero', () => {
    expect(nonZero([{ currency: 'EUR', amount: '0.00' }, { currency: 'USD', amount: '12.50' }])).toEqual([
      { currency: 'USD', amount: '12.50' },
    ]);
    expect(nonZero(undefined)).toEqual([]);
  });

  it('counts the documents the sums stand for', () => {
    expect(countOf([{ currency: 'EUR', amount: '1', count: 2 }, { currency: 'USD', amount: '1', count: 1 }])).toBe(3);
    expect(countOf(undefined)).toBe(0);
  });

  it('shows one currency in full and none as a zero', () => {
    expect(describeSums([{ currency: 'EUR', amount: '1815.00', count: 1 }], money)).toEqual({
      primary: 'EUR 1815.00',
      others: [],
      isEmpty: false,
    });
    expect(describeSums([], money, 'USD')).toEqual({ primary: 'USD 0.00', others: [], isEmpty: true });
  });

  it('keeps several currencies apart instead of making up a total', () => {
    const sums = describeSums(
      [
        { currency: 'EUR', amount: '100.00' },
        { currency: 'USD', amount: '40.00' },
        { currency: 'GBP', amount: '5.00' },
      ],
      money,
    );
    expect(sums.primary).toBe('EUR 100.00');
    expect(sums.others).toEqual(['USD 40.00', 'GBP 5.00']);
  });
});

describe('timeline items', () => {
  it('is loud for what needs attention and calm for the rest', () => {
    expect(timelineTone({ type: 'invoice', hint: 'overdue', status: 'overdue' })).toBe('danger');
    expect(timelineTone({ type: 'quote', hint: 'expired', status: 'sent' })).toBe('danger');
    expect(timelineTone({ type: 'email_bounced', hint: null, status: null })).toBe('danger');
    expect(timelineTone({ type: 'reminder', hint: 'level:2', status: null })).toBe('warning');
    expect(timelineTone({ type: 'invoice', hint: null, status: 'paid' })).toBe('success');
    expect(timelineTone({ type: 'payment', hint: 'received', status: null })).toBe('success');
    expect(timelineTone({ type: 'email_viewed', hint: null, status: null })).toBe('info');
    expect(timelineTone({ type: 'bank_line', hint: 'in', status: 'reconciled' })).toBe('neutral');
  });

  it('reads the level of a reminder from its hint', () => {
    expect(reminderLevel('level:3')).toBe(3);
    expect(reminderLevel('overdue')).toBeNull();
    expect(reminderLevel(null)).toBeNull();
  });
});
