import { afterEach, describe, expect, it } from 'vitest';
import type { SearchResultGroup } from '@weldsuite/app-api-client/schemas/search';
import { setRuntimeConfig } from '@/lib/runtime-config';
import { BOOKS_SEARCH_TYPES, booksSearchTypes, mergeSearchGroups } from './books-search-types';

function group(type: SearchResultGroup['type'], ids: string[]): SearchResultGroup {
  return {
    type,
    items: ids.map((id) => ({ id, type, title: id, url: `/x/${id}` })),
    totalCount: ids.length,
    hasMore: false,
  };
}

describe('booksSearchTypes', () => {
  afterEach(() => setRuntimeConfig(null));

  it('names bank lines, contacts and inbox documents', () => {
    expect(BOOKS_SEARCH_TYPES).toEqual(['bank_transaction', 'accounting_contact', 'accounting_document']);
  });

  it('asks for them where WeldBooks is installed and the edition serves them', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] });
    expect(booksSearchTypes(true)).toEqual(['bank_transaction', 'accounting_contact', 'accounting_document']);
  });

  it('asks for none without WeldBooks', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] });
    expect(booksSearchTypes(false)).toEqual([]);
  });

  it('asks for none where the edition lacks the Rust books features (Global, or books-todo unavailable)', () => {
    expect(booksSearchTypes(true)).toEqual([]);
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'books'], unavailableFeatures: ['books-todo'] });
    expect(booksSearchTypes(true)).toEqual([]);
  });

  it('hands out a copy, so a caller cannot change the list', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] });
    booksSearchTypes(true).pop();
    expect(booksSearchTypes(true)).toHaveLength(3);
  });
});

describe('mergeSearchGroups', () => {
  it('puts the usual groups first and the opt-in ones after', () => {
    const merged = mergeSearchGroups([group('customer', ['c1']), group('invoice', ['i1'])], [group('bank_transaction', ['b1'])]);
    expect(merged.map((g) => g.type)).toEqual(['customer', 'invoice', 'bank_transaction']);
  });

  it('lists a type once, from the first list', () => {
    const merged = mergeSearchGroups([group('invoice', ['i1'])], [group('invoice', ['i2'])]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.items[0]?.id).toBe('i1');
  });

  it('handles a response that is not there yet', () => {
    expect(mergeSearchGroups(undefined, undefined)).toEqual([]);
    expect(mergeSearchGroups(undefined, [group('bill', ['b1'])])).toHaveLength(1);
  });
});
