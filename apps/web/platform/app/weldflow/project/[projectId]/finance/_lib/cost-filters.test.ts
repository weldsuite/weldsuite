import { describe, expect, it } from 'vitest';
import type { ActiveFilter } from '@weldsuite/ui/components/list-toolbar';
import { toCostQuery } from './cost-filters';

function pill(field: string, operator: string, value: string): ActiveFilter {
  return { id: `${field}-${operator}-${value}`, field, operator, value };
}

describe('toCostQuery', () => {
  it('is empty without pills, and skips a pill that has no value yet', () => {
    expect(toCostQuery([])).toEqual({ filters: {} });
    expect(toCostQuery([pill('source', 'is', ''), pill('date', '', '')])).toEqual({ filters: {} });
  });

  it('sends "source is" to the API and keeps "source is not" for the loaded lines', () => {
    expect(toCostQuery([pill('source', 'is', 'bill')])).toEqual({ filters: { source: 'bill' } });
    expect(toCostQuery([pill('source', 'is not', 'time')])).toEqual({ filters: {}, excludedSource: 'time' });
  });

  it('ignores a source the API does not know', () => {
    expect(toCostQuery([pill('source', 'is', 'invoice')])).toEqual({ filters: {} });
  });

  it('turns after, before and is into an inclusive range', () => {
    expect(toCostQuery([pill('date', 'after', '2026-10-31')]).filters).toEqual({ from: '2026-11-01' });
    expect(toCostQuery([pill('date', 'before', '2026-03-01')]).filters).toEqual({ to: '2026-02-28' });
    expect(toCostQuery([pill('date', 'is', '2026-07-15')]).filters).toEqual({ from: '2026-07-15', to: '2026-07-15' });
  });

  it('narrows the range when there are several date pills', () => {
    const query = toCostQuery([
      pill('date', 'after', '2026-01-01'),
      pill('date', 'after', '2026-05-31'),
      pill('date', 'before', '2026-12-01'),
      pill('date', 'before', '2026-09-01'),
    ]);
    expect(query.filters).toEqual({ from: '2026-06-01', to: '2026-08-31' });
  });
});
