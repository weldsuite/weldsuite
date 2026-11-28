import { describe, expect, it } from 'vitest';
import {
  buildCategorizeInput,
  newSplitRow,
  nextRowAmount,
  remainderCents,
  splitProblem,
  type SplitRow,
} from './split-model';

const row = (patch: Partial<SplitRow>): SplitRow => ({ ...newSplitRow(), accountId: 'acc_1', ...patch });

describe('split model', () => {
  it('measures the remainder against the absolute amount of the line', () => {
    expect(remainderCents('-89.95', [row({ amount: '50.00' })])).toBe(3995);
    expect(remainderCents('120.00', [row({ amount: '120,00' })])).toBe(0);
    expect(remainderCents('100', [row({ amount: '60' }), row({ amount: '50' })])).toBe(-1000);
  });

  it('accepts rows that add up to the line, and nothing else', () => {
    expect(splitProblem('-100.00', [row({ amount: '100.00' })])).toBeNull();
    expect(splitProblem('-100.00', [row({ amount: '60.00' }), row({ amount: '40.00' })])).toBeNull();
    expect(splitProblem('-100.00', [row({ amount: '60.00' })])).toBe('notBalanced');
    expect(splitProblem('-100.00', [row({ amount: '60.00' }), row({ amount: '50.00' })])).toBe('notBalanced');
  });

  it('refuses a row without a category or with a bad or zero amount', () => {
    expect(splitProblem('10', [row({ amount: '10', accountId: '' })])).toBe('noCategory');
    expect(splitProblem('10', [row({ amount: 'abc' })])).toBe('badAmount');
    expect(splitProblem('10', [row({ amount: '0' }), row({ amount: '10' })])).toBe('badAmount');
    expect(splitProblem('10', [])).toBe('tooMany');
  });

  it('builds the body without empty optional ids and with plain decimal amounts', () => {
    const body = buildCategorizeInput([
      row({ amount: '60,5', taxRateId: 'tax_1', contactId: 'con_1' }),
      row({ amount: '39.50', accountId: 'acc_2', projectId: 'prj_1' }),
    ]);
    expect(body).toEqual({
      lines: [
        { accountId: 'acc_1', amount: '60.50', taxRateId: 'tax_1', contactId: 'con_1' },
        { accountId: 'acc_2', amount: '39.50', projectId: 'prj_1' },
      ],
    });
  });

  it('starts a new row with what is left, never a negative amount', () => {
    expect(nextRowAmount('100.00', [row({ amount: '60.00' })])).toBe('40.00');
    expect(nextRowAmount('100.00', [row({ amount: '100.00' })])).toBe('');
    expect(nextRowAmount('100.00', [row({ amount: '120.00' })])).toBe('');
  });
});
