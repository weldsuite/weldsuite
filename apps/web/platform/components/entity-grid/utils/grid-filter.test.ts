import { describe, it, expect } from 'vitest';
import type { GridColumnDef } from '../types';
import {
  coerceFilterValue,
  filterValueList,
  getFilterOperators,
  isSelectFilterColumn,
  matchesFilter,
  operatorNeedsValue,
} from './grid-filter';

const statusColumn: Pick<GridColumnDef<unknown>, 'type' | 'options'> = {
  type: 'single-select',
  options: ['active', 'prospect', 'custom_vip'],
};
const textColumn: Pick<GridColumnDef<unknown>, 'type' | 'options'> = { type: 'text' };

describe('getFilterOperators', () => {
  it('offers a select column its options-based operators, not free-text ones', () => {
    expect(getFilterOperators(statusColumn)).toEqual(['equals', 'not_equals', 'in', 'is_empty', 'is_not_empty']);
  });

  it('keeps the free-text operators for other columns', () => {
    expect(getFilterOperators(textColumn)).toEqual([
      'contains',
      'equals',
      'starts_with',
      'is_empty',
      'is_not_empty',
    ]);
  });

  it('treats a select column without options as free text (nothing to pick from)', () => {
    expect(isSelectFilterColumn({ type: 'single-select', options: [] })).toBe(false);
    expect(isSelectFilterColumn({ type: 'single-select' })).toBe(false);
    expect(isSelectFilterColumn(undefined)).toBe(false);
  });
});

describe('matchesFilter', () => {
  it('matches a status by its key, case-insensitively', () => {
    expect(matchesFilter('active', { operator: 'equals', value: 'Active' })).toBe(true);
    expect(matchesFilter('prospect', { operator: 'equals', value: 'active' })).toBe(false);
  });

  it('supports "is not"', () => {
    expect(matchesFilter('active', { operator: 'not_equals', value: 'active' })).toBe(false);
    expect(matchesFilter('prospect', { operator: 'not_equals', value: 'active' })).toBe(true);
  });

  it('supports "is any of", including a custom status key', () => {
    const filter = { operator: 'in', value: ['active', 'custom_vip'] } as const;
    expect(matchesFilter('custom_vip', filter)).toBe(true);
    expect(matchesFilter('active', filter)).toBe(true);
    expect(matchesFilter('prospect', filter)).toBe(false);
  });

  it('matches an array cell (tags) when any element matches', () => {
    expect(matchesFilter(['vip', 'partner'], { operator: 'equals', value: 'Partner' })).toBe(true);
    expect(matchesFilter(['vip'], { operator: 'in', value: ['partner', 'vip'] })).toBe(true);
    expect(matchesFilter(['vip'], { operator: 'not_equals', value: 'vip' })).toBe(false);
  });

  it('lets every row through while the filter has no value yet', () => {
    expect(matchesFilter('active', { operator: 'equals', value: '' })).toBe(true);
    expect(matchesFilter('active', { operator: 'in', value: [] })).toBe(true);
    expect(matchesFilter('active', { operator: 'contains', value: undefined })).toBe(true);
  });

  it('keeps the existing text operators', () => {
    expect(matchesFilter('Acme Industries', { operator: 'contains', value: 'acme' })).toBe(true);
    expect(matchesFilter('Acme Industries', { operator: 'starts_with', value: 'ind' })).toBe(false);
    expect(matchesFilter('Acme Industries', { operator: 'equals', value: 'acme industries' })).toBe(true);
  });

  it('handles empty checks for strings, null and empty arrays', () => {
    expect(matchesFilter('', { operator: 'is_empty', value: '' })).toBe(true);
    expect(matchesFilter(null, { operator: 'is_empty', value: '' })).toBe(true);
    expect(matchesFilter([], { operator: 'is_empty', value: '' })).toBe(true);
    expect(matchesFilter(['a'], { operator: 'is_not_empty', value: '' })).toBe(true);
    expect(matchesFilter('x', { operator: 'is_empty', value: '' })).toBe(false);
  });

  it('compares numbers', () => {
    expect(matchesFilter(10, { operator: 'gt', value: '5' })).toBe(true);
    expect(matchesFilter(10, { operator: 'lte', value: '5' })).toBe(false);
  });
});

describe('filter value helpers', () => {
  it('lists the selected values', () => {
    expect(filterValueList(['a', '', 'b'])).toEqual(['a', 'b']);
    expect(filterValueList('a')).toEqual(['a']);
    expect(filterValueList('')).toEqual([]);
    expect(filterValueList(undefined)).toEqual([]);
  });

  it('keeps the picked value when the operator switches between one value and a list', () => {
    expect(coerceFilterValue('active', 'in')).toEqual(['active']);
    expect(coerceFilterValue(['active', 'prospect'], 'equals')).toBe('active');
    expect(coerceFilterValue([], 'equals')).toBe('');
  });

  it('knows which operators take a value', () => {
    expect(operatorNeedsValue('equals')).toBe(true);
    expect(operatorNeedsValue('is_empty')).toBe(false);
    expect(operatorNeedsValue('is_not_empty')).toBe(false);
  });
});
