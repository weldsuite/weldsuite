import { describe, expect, it } from 'vitest';
import { activeFilterCount, cleanSearch, parseRecordingsSearch, recordingsSpec, searchRange, withRange } from './recordings-search';

describe('recordings search', () => {
  it('keeps what parses and drops what does not', () => {
    expect(parseRecordingsSearch({ range: '7d', errors: true, minDuration: 'abc', frustration: ['rage', 'nope'], bogus: 1 })).toEqual({ range: '7d', errors: true });
    expect(parseRecordingsSearch(undefined)).toEqual({});
  });

  it('counts the filters that are on, not the period, sort or project', () => {
    expect(activeFilterCount({ range: '7d', sort: 'duration_desc', project: 'wpp_1' })).toBe(0);
    expect(activeFilterCount({ errors: true, pages: ['/a', '/b'], did: [], favorites: false, user: 'u' })).toBe(3);
  });

  it('builds the spec: only recordings, the period from the URL', () => {
    const spec = recordingsSpec({ from: '2026-11-01', to: '2026-11-07', devices: ['mobile'], user: 'user_1' }, 'wpp_1');
    expect(spec).toMatchObject({ kind: 'sessions', projectId: 'wpp_1', hasRecording: true, dateRange: { from: '2026-11-01', to: '2026-11-07' }, devices: ['mobile'], distinctId: 'user_1', limit: 25 });
  });

  it('reads and replaces the date range', () => {
    expect(searchRange({})).toEqual({ preset: '30d' });
    expect(searchRange({ from: '2026-11-01', to: '2026-11-02' })).toEqual({ from: '2026-11-01', to: '2026-11-02' });
    expect(withRange({ range: '7d', errors: true }, { from: '2026-11-01', to: '2026-11-02' })).toEqual({ errors: true, from: '2026-11-01', to: '2026-11-02' });
    expect(withRange({ from: '2026-11-01', to: '2026-11-02' }, { preset: '90d' })).toEqual({ range: '90d' });
  });

  it('cleans empty values out', () => {
    expect(cleanSearch({ errors: false, pages: [], user: '', range: '7d', entryPage: undefined })).toEqual({ range: '7d' });
  });
});
