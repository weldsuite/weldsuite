import { describe, expect, it } from 'vitest';
import {
  MAX_ZIP_ENTRIES,
  countZips,
  formatZipList,
  parseZipList,
  summarizeZipList,
  zipListCovers,
} from './zip-list';

describe('parseZipList', () => {
  it('reads single ZIPs and ranges separated by commas', () => {
    expect(parseZipList('78701, 78702, 78710-78799')).toEqual({
      entries: ['78701', '78702', { from: '78710', to: '78799' }],
      errors: [],
    });
  });

  it('also splits on spaces, semicolons and line breaks', () => {
    expect(parseZipList('78701 78702;78703\n78704\r\n78705').entries).toEqual(['78701', '78702', '78703', '78704', '78705']);
  });

  it('accepts a range with an en dash, an em dash or spaces around the dash', () => {
    const expected = [{ from: '78710', to: '78799' }];
    expect(parseZipList('78710–78799').entries).toEqual(expected);
    expect(parseZipList('78710—78799').entries).toEqual(expected);
    expect(parseZipList('78710 - 78799').entries).toEqual(expected);
  });

  it('keeps the order typed and drops repeats', () => {
    expect(parseZipList('78702, 78701, 78702, 78710-78799, 78710-78799').entries).toEqual([
      '78702',
      '78701',
      { from: '78710', to: '78799' },
    ]);
  });

  it('reads a range of one ZIP as that ZIP', () => {
    expect(parseZipList('78701-78701').entries).toEqual(['78701']);
  });

  it('returns nothing for blank text', () => {
    expect(parseZipList('')).toEqual({ entries: [], errors: [] });
    expect(parseZipList('  \n , ; ')).toEqual({ entries: [], errors: [] });
  });

  it('reports what it could not read and keeps the rest', () => {
    const result = parseZipList('78701, 7870, abc, 78702');
    expect(result.entries).toEqual(['78701', '78702']);
    expect(result.errors).toEqual([
      { token: '7870', problem: 'format' },
      { token: 'abc', problem: 'format' },
    ]);
  });

  it('refuses a ZIP+4 instead of guessing', () => {
    expect(parseZipList('78701-1234').errors).toEqual([{ token: '78701-1234', problem: 'zip4' }]);
  });

  it('refuses a range that runs backwards', () => {
    expect(parseZipList('78799-78710')).toEqual({
      entries: [],
      errors: [{ token: '78799-78710', problem: 'backwards' }],
    });
  });

  it('refuses more entries than a zone can hold', () => {
    const many = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => String(10000 + i)).join(',');
    expect(parseZipList(many).errors).toEqual([{ token: '', problem: 'too_many' }]);
    expect(parseZipList(many.split(',').slice(0, MAX_ZIP_ENTRIES).join(',')).errors).toEqual([]);
  });
});

describe('formatZipList', () => {
  it('writes ranges with a hyphen and joins with commas', () => {
    expect(formatZipList(['78701', { from: '78710', to: '78799' }, '78702'])).toBe('78701, 78710-78799, 78702');
  });

  it('is empty for no list', () => {
    expect(formatZipList([])).toBe('');
    expect(formatZipList(null)).toBe('');
    expect(formatZipList(undefined)).toBe('');
  });

  it('round-trips through parseZipList', () => {
    const entries = ['78701', { from: '78710', to: '78799' }, '90210'];
    expect(parseZipList(formatZipList(entries)).entries).toEqual(entries);
  });
});

describe('countZips', () => {
  it('counts every ZIP of a range', () => {
    expect(countZips(['78701', { from: '78710', to: '78719' }])).toBe(11);
    expect(countZips(null)).toBe(0);
  });
});

describe('summarizeZipList', () => {
  it('shows the first entries and how many more there are', () => {
    expect(summarizeZipList(['1', '2', '3', '4', '5', '6'].map((n) => `7870${n}`), 4)).toEqual({
      text: '78701, 78702, 78703, 78704',
      more: 2,
    });
    expect(summarizeZipList(['78701'])).toEqual({ text: '78701', more: 0 });
  });
});

describe('zipListCovers', () => {
  const list = ['78701', { from: '78710', to: '78799' }];
  it('matches singles and inclusive ranges on the five-digit ZIP', () => {
    expect(zipListCovers(list, '78701')).toBe(true);
    expect(zipListCovers(list, '78710')).toBe(true);
    expect(zipListCovers(list, '78799')).toBe(true);
    expect(zipListCovers(list, '78800')).toBe(false);
    expect(zipListCovers(list, '78701-1234')).toBe(true);
    expect(zipListCovers(list, '787')).toBe(false);
  });
});
