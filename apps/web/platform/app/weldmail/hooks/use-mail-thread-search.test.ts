import { describe, expect, it } from 'vitest';
import { hasThreadSearch, normalizeThreadSearch } from './use-mail-thread-search';

describe('normalizeThreadSearch', () => {
  it('trims text and drops empty fields', () => {
    expect(
      normalizeThreadSearch({ search: '  osprey ', from: '', to: '   ', subject: 'Invoice', hasAttachment: false }),
    ).toEqual({ search: 'osprey', subject: 'Invoice' });
  });

  it('keeps the attachment filter only when it is on', () => {
    expect(normalizeThreadSearch({ hasAttachment: true })).toEqual({ hasAttachment: true });
    expect(normalizeThreadSearch({ hasAttachment: false })).toEqual({});
  });
});

describe('hasThreadSearch', () => {
  it('is false for an empty or whitespace-only search', () => {
    expect(hasThreadSearch({})).toBe(false);
    expect(hasThreadSearch({ search: '   ', from: '' })).toBe(false);
  });

  it('is true as soon as one field narrows the list', () => {
    expect(hasThreadSearch({ search: 'zebrafinch' })).toBe(true);
    expect(hasThreadSearch({ hasAttachment: true })).toBe(true);
  });
});
