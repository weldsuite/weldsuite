import { describe, expect, it } from 'vitest';
import type { ActiveFilter } from '@/components/entity-list';
import { applyExclusions, dateBounds, pillValue } from './list-filters';

const pill = (field: string, operator: string, value: string): ActiveFilter => ({ id: `${field}-${operator}`, field, operator, value });

describe('pillValue', () => {
  it('reads a finished pill and ignores one still being built', () => {
    const active = [pill('status', 'is', 'posted'), pill('account', '', ''), pill('source', 'is', '')];
    expect(pillValue(active, 'status')).toBe('posted');
    expect(pillValue(active, 'account')).toBeUndefined();
    expect(pillValue(active, 'source')).toBeUndefined();
    expect(pillValue(active, 'status', 'is not')).toBeUndefined();
  });
});

describe('dateBounds', () => {
  it('maps after / before to from / to, and is to both', () => {
    expect(dateBounds([pill('date', 'after', '2026-01-01'), pill('date', 'before', '2026-02-01')], 'date')).toEqual({
      from: '2026-01-01',
      to: '2026-02-01',
    });
    expect(dateBounds([pill('date', 'is', '2026-03-05')], 'date')).toEqual({ from: '2026-03-05', to: '2026-03-05' });
    expect(dateBounds([], 'date')).toEqual({ from: undefined, to: undefined });
  });
});

describe('applyExclusions', () => {
  const items = [{ status: 'posted' }, { status: 'void' }];
  const accessors = { status: (row: { status: string }) => row.status };

  it('drops the rows an is-not pill rules out', () => {
    expect(applyExclusions(items, [pill('status', 'is not', 'void')], accessors)).toEqual([{ status: 'posted' }]);
  });

  it('leaves the rows alone for is pills and unfinished pills', () => {
    expect(applyExclusions(items, [pill('status', 'is', 'void'), pill('status', 'is not', '')], accessors)).toBe(items);
  });
});
