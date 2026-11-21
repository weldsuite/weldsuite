import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelFilter } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { describeFilter, hasColumnFilter, isFilterComplete, operatorNeedsValue, parseFilterValue, toggleColumnFilter } from './filters';

const labels = en.weldpanel.analytics.filters;

describe('isFilterComplete', () => {
  it('needs a value unless the operator is is_set or is_not_set', () => {
    expect(isFilterComplete({ source: 'column', field: 'country', operator: 'eq' })).toBe(false);
    expect(isFilterComplete({ source: 'column', field: 'country', operator: 'eq', value: 'NL' })).toBe(true);
    expect(isFilterComplete({ source: 'event', key: 'plan', operator: 'is_set' })).toBe(true);
  });

  it('needs a property name and a non-empty list for "in"', () => {
    expect(isFilterComplete({ source: 'person', key: '', operator: 'eq', value: 'x' })).toBe(false);
    expect(isFilterComplete({ source: 'event', key: 'plan', operator: 'in', value: [] })).toBe(false);
    expect(isFilterComplete({ source: 'event', key: 'plan', operator: 'in', value: ['pro'] })).toBe(true);
  });

  it('needs a cohort id', () => {
    expect(isFilterComplete({ source: 'cohort', cohortId: '' })).toBe(false);
    expect(isFilterComplete({ source: 'cohort', cohortId: 'wpc_1' })).toBe(true);
  });
});

describe('parseFilterValue', () => {
  it('splits a list for "in" and drops empty parts', () => {
    expect(parseFilterValue('pro, team,,', 'in')).toEqual(['pro', 'team']);
    expect(parseFilterValue(' , ', 'in')).toBeUndefined();
  });

  it('reads numbers for gt and lt, text otherwise', () => {
    expect(parseFilterValue('42', 'gt')).toBe(42);
    expect(parseFilterValue('abc', 'lt')).toBe('abc');
    expect(parseFilterValue('42', 'eq')).toBe('42');
  });

  it('has no value for is_set', () => {
    expect(operatorNeedsValue('is_set')).toBe(false);
    expect(parseFilterValue('x', 'is_not_set')).toBeUndefined();
  });
});

describe('toggleColumnFilter', () => {
  const nl: PanelFilter = { source: 'column', field: 'country', operator: 'eq', value: 'NL' };

  it('adds a click filter', () => {
    expect(toggleColumnFilter([], 'country', 'NL')).toEqual([nl]);
  });

  it('replaces an earlier filter on the same field and keeps the others', () => {
    const other: PanelFilter = { source: 'column', field: 'path', operator: 'eq', value: '/' };
    expect(toggleColumnFilter([nl, other], 'country', 'DE')).toEqual([other, { ...nl, value: 'DE' }]);
  });

  it('removes the filter when the same row is clicked again', () => {
    expect(hasColumnFilter([nl], 'country', 'NL')).toBe(true);
    expect(toggleColumnFilter([nl], 'country', 'NL')).toEqual([]);
  });
});

describe('describeFilter', () => {
  it('reads like a sentence', () => {
    expect(describeFilter({ source: 'column', field: 'country', operator: 'eq', value: 'NL' }, labels)).toBe('Country is NL');
    expect(describeFilter({ source: 'event', key: 'plan', operator: 'in', value: ['pro', 'team'] }, labels)).toBe('plan is one of pro, team');
    expect(describeFilter({ source: 'person', key: 'email', operator: 'is_set' }, labels)).toBe('email is set');
  });

  it('names the cohort, or says it was removed', () => {
    const filter: PanelFilter = { source: 'cohort', cohortId: 'wpc_1', negate: true };
    expect(describeFilter(filter, labels, () => 'Trial users')).toBe('not in Trial users');
    expect(describeFilter(filter, labels, () => undefined)).toBe('not in a removed cohort');
  });
});
