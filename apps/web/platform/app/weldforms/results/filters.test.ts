import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  MAX_ANSWER_FILTERS,
  activeFilterCount,
  operatorsFor,
  serializeFilters,
  toAnswerFilter,
  toResponsesQuery,
  type AnswerFilterDraft,
} from './filters';

const draft = (patch: Partial<AnswerFilterDraft>): AnswerFilterDraft => ({
  key: 'k',
  blockId: 'blk1',
  operator: 'is',
  ...patch,
});

describe('toAnswerFilter', () => {
  it('drops a filter that still lacks a value', () => {
    expect(toAnswerFilter(draft({ value: '  ' }))).toBeNull();
    expect(toAnswerFilter(draft({ operator: 'any_of', value: [] }))).toBeNull();
    expect(toAnswerFilter(draft({ blockId: '' }))).toBeNull();
  });

  it('needs no value for is_answered and is_empty', () => {
    expect(toAnswerFilter(draft({ operator: 'is_answered' }))).toEqual({ blockId: 'blk1', operator: 'is_answered' });
  });

  it('turns numeric text into a number for comparisons, and keeps dates as text', () => {
    expect(toAnswerFilter(draft({ operator: 'greater_than', value: '4' }))).toEqual({
      blockId: 'blk1',
      operator: 'greater_than',
      value: 4,
    });
    expect(toAnswerFilter(draft({ operator: 'less_than', value: '2026-01-01' }))).toEqual({
      blockId: 'blk1',
      operator: 'less_than',
      value: '2026-01-01',
    });
  });

  it('keeps the sub-field of a composite answer', () => {
    expect(toAnswerFilter(draft({ part: 'city', operator: 'contains', value: 'Gent' }))).toEqual({
      blockId: 'blk1',
      part: 'city',
      operator: 'contains',
      value: 'Gent',
    });
  });
});

describe('serializeFilters', () => {
  it('is undefined without a complete filter', () => {
    expect(serializeFilters([])).toBeUndefined();
    expect(serializeFilters([draft({ value: '' })])).toBeUndefined();
  });

  it('encodes the complete ones as JSON', () => {
    const json = serializeFilters([draft({ operator: 'any_of', value: ['a', 'b'] }), draft({ value: '' })]);
    expect(JSON.parse(json ?? '[]')).toEqual([{ blockId: 'blk1', operator: 'any_of', value: ['a', 'b'] }]);
  });

  it('caps the number of filters', () => {
    const many = Array.from({ length: MAX_ANSWER_FILTERS + 5 }, (_, i) => draft({ key: String(i), value: String(i) }));
    expect(JSON.parse(serializeFilters(many) ?? '[]')).toHaveLength(MAX_ANSWER_FILTERS);
  });

  it('refuses a payload longer than the API accepts', () => {
    const big = Array.from({ length: MAX_ANSWER_FILTERS }, (_, i) => draft({ key: String(i), value: 'x'.repeat(400) }));
    expect(serializeFilters(big)).toBeUndefined();
  });
});

describe('toResponsesQuery', () => {
  it('sends nothing for the default state', () => {
    expect(toResponsesQuery(EMPTY_FILTERS)).toEqual({});
  });

  it('maps status, dates, search, version, sort and answer filters', () => {
    const query = toResponsesQuery({
      ...EMPTY_FILTERS,
      status: 'completed',
      from: '2026-03-01',
      to: '2026-03-31',
      q: ' anna ',
      versionId: 'ver1',
      sort: 'score_desc',
      answers: [draft({ value: 'yes' })],
    });
    expect(query.status).toBe('completed');
    expect(new Date(query.from ?? '').getTime()).toBeLessThan(new Date(query.to ?? '').getTime());
    expect(query.q).toBe('anna');
    expect(query.versionId).toBe('ver1');
    expect(query.sort).toBe('score_desc');
    expect(JSON.parse(query.filters ?? '[]')).toHaveLength(1);
  });

  it('ignores a malformed date', () => {
    expect(toResponsesQuery({ ...EMPTY_FILTERS, from: '31/03/2026' })).toEqual({});
  });
});

describe('activeFilterCount and operatorsFor', () => {
  it('counts what is applied', () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(
      activeFilterCount({
        ...EMPTY_FILTERS,
        status: 'completed',
        from: '2026-01-01',
        answers: [draft({ value: 'x' }), draft({ value: '' })],
      }),
    ).toBe(3);
  });

  it('offers operators by field type', () => {
    expect(operatorsFor('multiple_choice')[0]).toBe('any_of');
    expect(operatorsFor('nps')).toContain('greater_than');
    expect(operatorsFor('file_upload')).toEqual(['is_answered', 'is_empty']);
  });
});
