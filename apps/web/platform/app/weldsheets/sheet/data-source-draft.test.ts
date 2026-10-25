import { describe, expect, it } from 'vitest';
import { defaultSheetDataColumns } from '@weldsuite/app-api-client/schemas/sheet-data';
import type { SheetDataSource } from '@weldsuite/app-api-client/schemas/sheets';
import { definitionOf, draftIsValid, draftOf, moveColumn, newDraft, newFilter, refield, type SourceDraft } from './data-source-draft';

const label = (_object: string, field: string) => `Label ${field}`;

function source(overrides: Partial<SheetDataSource> = {}): SheetDataSource {
  return {
    id: 'sds_1',
    sheetId: 'sht_1',
    objectType: 'companies',
    definition: {
      columns: ['name', 'leadScore'],
      headers: ['Company', 'Score'],
      filters: [
        { field: 'leadScore', op: 'gte', value: 50 },
        { field: 'isSupplier', op: 'eq', value: false },
        { field: 'email', op: 'notEmpty' },
      ],
      sort: { field: 'leadScore', descending: true },
      limit: 250,
    },
    refresh: 'daily',
    lastRefreshedAt: null,
    nextRefreshAt: null,
    lastError: null,
    rowCount: 0,
    createdById: 'user_alice',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('connected table drafts', () => {
  it('starts a new table with the object usual fields under their names', () => {
    const draft = newDraft('companies', label);
    expect(draft.columns.map((c) => c.field)).toEqual(defaultSheetDataColumns('companies'));
    expect(draft.columns[0]!.header).toBe(`Label ${draft.columns[0]!.field}`);
    expect(draft).toMatchObject({ filters: [], sort: null, limit: '1000', refresh: 'manual' });
    expect(draftIsValid(draft)).toBe(true);
  });

  it('turns a saved table into a draft and back without change', () => {
    const saved = source();
    const draft = draftOf(saved);
    expect(draft.filters.map((f) => f.value)).toEqual(['50', 'false', '']);
    expect(definitionOf(draft)).toEqual(saved.definition);
    expect(draftIsValid(draft)).toBe(true);
  });

  it('reads filter values as their field kind', () => {
    const draft: SourceDraft = {
      ...newDraft('companies', label),
      filters: [
        { field: 'leadScore', op: 'gt', value: ' 12.5 ' },
        { field: 'isSupplier', op: 'eq', value: 'true' },
        { field: 'nextFollowUpDate', op: 'lt', value: '2026-12-31' },
        { field: 'name', op: 'contains', value: ' acme ' },
        { field: 'email', op: 'empty', value: 'ignored' },
      ],
    };
    expect(definitionOf(draft).filters).toEqual([
      { field: 'leadScore', op: 'gt', value: 12.5 },
      { field: 'isSupplier', op: 'eq', value: true },
      { field: 'nextFollowUpDate', op: 'lt', value: '2026-12-31' },
      { field: 'name', op: 'contains', value: 'acme' },
      { field: 'email', op: 'empty' },
    ]);
    expect(draftIsValid(draft)).toBe(true);
  });

  it('cannot be saved with an empty title, an unreadable value or a bad limit', () => {
    const base = newDraft('companies', label);
    const withFilter = (filter: SourceDraft['filters'][number]): SourceDraft => ({ ...base, filters: [filter] });
    expect(draftIsValid({ ...base, columns: [{ ...base.columns[0]!, header: '  ' }] })).toBe(false);
    expect(draftIsValid(withFilter({ field: 'leadScore', op: 'gt', value: 'lots' }))).toBe(false);
    expect(draftIsValid(withFilter({ field: 'leadScore', op: 'gt', value: '' }))).toBe(false);
    expect(draftIsValid(withFilter({ field: 'nextFollowUpDate', op: 'lt', value: '31-12-2026' }))).toBe(false);
    expect(draftIsValid(withFilter({ field: 'name', op: 'eq', value: '' }))).toBe(false);
    expect(draftIsValid({ ...base, limit: '0' })).toBe(false);
    expect(draftIsValid({ ...base, limit: '10001' })).toBe(false);
    expect(draftIsValid({ ...base, limit: '2.5' })).toBe(false);
  });

  it('gives a new filter an operator that fits its field, and keeps it across fields when it still fits', () => {
    expect(newFilter('companies', 'name')).toEqual({ field: 'name', op: 'eq', value: '' });
    expect(newFilter('companies', 'isSupplier')).toEqual({ field: 'isSupplier', op: 'eq', value: 'true' });
    const contains = { field: 'name', op: 'contains' as const, value: 'x' };
    expect(refield('companies', contains, 'email')).toEqual({ field: 'email', op: 'contains', value: '' });
    expect(refield('companies', contains, 'leadScore')).toEqual({ field: 'leadScore', op: 'eq', value: '' });
  });

  it('moves columns within bounds', () => {
    const cols = [
      { field: 'a', header: 'A' },
      { field: 'b', header: 'B' },
      { field: 'c', header: 'C' },
    ];
    expect(moveColumn(cols, 0, 1).map((c) => c.field)).toEqual(['b', 'a', 'c']);
    expect(moveColumn(cols, 2, -1).map((c) => c.field)).toEqual(['a', 'c', 'b']);
    expect(moveColumn(cols, 0, -1)).toBe(cols);
    expect(moveColumn(cols, 2, 1)).toBe(cols);
  });
});
