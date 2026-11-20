import { describe, expect, it } from 'vitest';
import { balanceOnNormalSide } from './account-balance';

describe('balanceOnNormalSide', () => {
  it('turns a credit account round: revenue of 865 is stored as -865.00', () => {
    expect(balanceOnNormalSide('-865.00', 'credit')).toBe(865);
    expect(balanceOnNormalSide('42.00', 'credit')).toBe(-42);
  });

  it('keeps a debit account as stored', () => {
    expect(balanceOnNormalSide('125.50', 'debit')).toBe('125.50');
    expect(balanceOnNormalSide(-10, 'debit')).toBe(-10);
  });

  it('shows no -0 and leaves a missing balance alone', () => {
    expect(Object.is(balanceOnNormalSide('0.00', 'credit'), 0)).toBe(true);
    expect(balanceOnNormalSide(null, 'credit')).toBeNull();
    expect(balanceOnNormalSide(undefined, 'credit')).toBeUndefined();
  });
});
