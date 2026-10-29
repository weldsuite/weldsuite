import { describe, expect, it } from 'vitest';
import { firstDifference, normalizeForDiff } from './conformance';
import { schemaFor } from './conformance-schemas';

describe('conformance comparison', () => {
  it('ignores key order and nothing else on reads', () => {
    const ts = { data: { b: 1, a: [1, 2], at: '2026-10-29T07:00:00.000Z' } };
    const rust = { data: { a: [1, 2], at: '2026-10-29T07:00:00.000Z', b: 1 } };
    expect(firstDifference(normalizeForDiff(ts, false), normalizeForDiff(rust, false))).toBeNull();

    const later = { data: { a: [1, 2], at: '2026-10-29T07:00:01.000Z', b: 1 } };
    expect(firstDifference(normalizeForDiff(ts, false), normalizeForDiff(later, false))).toBe(
      '$.data.at: "2026-10-29T07:00:00.000Z" vs "2026-10-29T07:00:01.000Z"',
    );
  });

  it('normalises new ids, timestamps and cursors on writes only', () => {
    const ts = { data: { id: 'comp_mh2k3j4lab12cd34', createdAt: '2026-10-29T07:00:00.000Z' }, pagination: { cursor: 'abc' } };
    const rust = { data: { id: 'comp_mh2k3j9zzz98yx76', createdAt: '2026-10-29T07:00:00.123Z' }, pagination: { cursor: 'xyz' } };
    expect(firstDifference(normalizeForDiff(ts, true), normalizeForDiff(rust, true))).toBeNull();
    expect(firstDifference(normalizeForDiff(ts, false), normalizeForDiff(rust, false))).not.toBeNull();
  });

  it('normalises a new API key and its display prefix on writes', () => {
    const minted = (hex: string) => ({ data: { id: `ak_mh2k3j4lab12${hex}`, keyPrefix: `wsk_${hex}`, key: `wsk_${hex.repeat(8)}` } });
    const ts = minted('0011aabb');
    const rust = minted('ffee9988');
    expect(firstDifference(normalizeForDiff(ts, true), normalizeForDiff(rust, true))).toBeNull();
    expect(firstDifference(normalizeForDiff(ts, false), normalizeForDiff(rust, false))).not.toBeNull();
    // Only a key prefix: a `keyPrefix` of another shape still compares.
    expect(normalizeForDiff({ keyPrefix: 'sk_live' }, true)).toEqual({ keyPrefix: 'sk_live' });
  });

  it('reports missing fields, extra fields and length differences', () => {
    expect(firstDifference({ a: 1 }, { a: 1, b: 2 })).toBe('$.b: undefined vs 2');
    expect(firstDifference({ a: [1] }, { a: [1, 2] })).toBe('$.a: 1 items vs 2');
    expect(firstDifference({ a: 1 }, { a: '1' })).toBe('$.a: 1 vs "1"');
  });

  it('validates registered routes against their Zod schema', () => {
    const validate = schemaFor('GET', '/api/me/permissions');
    expect(validate).toBeDefined();
    const ok = { data: { permissions: ['*'], denies: [], appEnforced: false, role: 'OWNER', roleId: null, isOwner: true } };
    expect(validate!(ok)).toBeNull();
    expect(validate!({ data: { ...ok.data, isOwner: 'yes' } })).toMatch(/isOwner/);
    expect(validate!({ permissions: [] })).toBe('no `data` in the response envelope');
    expect(schemaFor('POST', '/api/me/permissions')).toBeUndefined();
  });
});
