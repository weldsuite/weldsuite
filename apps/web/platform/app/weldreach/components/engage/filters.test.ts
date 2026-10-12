import { describe, expect, it } from 'vitest';
import { readFilter, selectFilterConfig, writeFilter } from './filters';

const pill = (field: string, operator: string, value: string) => ({ id: `${field}-1`, field, operator, value });

describe('readFilter', () => {
  it('reads "is" as a value for the server', () => {
    expect(readFilter([pill('status', 'is', 'paused')], 'status')).toEqual({ is: 'paused' });
  });

  it('reads "is not" as a value to leave out', () => {
    expect(readFilter([pill('status', 'is not', 'draft')], 'status')).toEqual({ isNot: 'draft' });
  });

  it('ignores a pill that has no value yet and other fields', () => {
    expect(readFilter([pill('status', '', '')], 'status')).toEqual({});
    expect(readFilter([pill('validation', 'is', 'role')], 'status')).toEqual({});
  });
});

describe('writeFilter', () => {
  it('replaces the field and keeps the others', () => {
    const next = writeFilter([pill('status', 'is not', 'draft'), pill('validation', 'is', 'role')], 'status', 'active');
    expect(next).toEqual([
      pill('validation', 'is', 'role'),
      { id: 'status-select', field: 'status', operator: 'is', value: 'active' },
    ]);
  });

  it('clears the field', () => {
    expect(writeFilter([pill('status', 'is', 'active')], 'status', undefined)).toEqual([]);
  });
});

describe('selectFilterConfig', () => {
  it('makes a pick-one pill', () => {
    expect(selectFilterConfig('status', 'Status', [{ value: 'a', label: 'A' }])).toEqual({
      field: 'status',
      label: 'Status',
      options: [{ value: 'a', label: 'A' }],
      filterType: 'select',
    });
  });
});
