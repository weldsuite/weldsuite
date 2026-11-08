import { describe, expect, it } from 'vitest';
import { alignClockSeconds, firstDifference, normalizeForDiff } from './conformance';
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

  it("normalises a realtime room payload's Date.now() `ts` on writes only", () => {
    const ts = { path: '/publish/support/org_1', body: { type: 'message', ts: 1793274036998, data: { size: 1793274036998 } } };
    const rust = { path: '/publish/support/org_1', body: { type: 'message', ts: 1793274037012, data: { size: 1793274036998 } } };
    expect(firstDifference(normalizeForDiff(ts, true), normalizeForDiff(rust, true))).toBeNull();
    expect(firstDifference(normalizeForDiff(ts, false), normalizeForDiff(rust, false))).toBe(
      '$.body.ts: 1793274036998 vs 1793274037012',
    );
    // Only `ts`, and only a millisecond epoch.
    expect(normalizeForDiff({ ts: 42, size: 1793274036998 }, true)).toEqual({ size: 1793274036998, ts: 42 });
  });

  it('normalises random hex tokens on writes only', () => {
    const ts = { data: { value: 'weldsuite-sso-verification=0f1e2d3c4b5a69788796a5b4c3d2e1f0' } };
    const rust = { data: { value: 'weldsuite-sso-verification=1234567890123abcdef0123456789abc' } };
    expect(firstDifference(normalizeForDiff(ts, true), normalizeForDiff(rust, true))).toBeNull();
    expect(firstDifference(normalizeForDiff(ts, false), normalizeForDiff(rust, false))).not.toBeNull();
    // Longer or shorter hex runs are not tokens.
    expect(normalizeForDiff('a'.repeat(33), true)).toBe('a'.repeat(33));
    expect(normalizeForDiff('a'.repeat(31), true)).toBe('a'.repeat(31));
  });

  it("lets seconds counted to each run's own now differ only by what their instants do", () => {
    const closed = (resolvedAt: string, resolutionSeconds: number | null) => ({
      data: { conversation: { id: 'dconv_dup', resolvedAt, resolutionSeconds, firstResponseAt: null, firstResponseSeconds: null } },
    });
    const compare = (ts: unknown, rust: unknown) =>
      firstDifference(normalizeForDiff(ts, true), normalizeForDiff(alignClockSeconds(ts, rust), true));

    // Main CI run 42524631286: the clock ticked over between the two runs.
    const ts = closed('2026-11-08T21:27:59.990Z', 26904419);
    expect(compare(ts, closed('2026-11-08T21:28:00.015Z', 26904420))).toBeNull();
    expect(compare(ts, closed('2026-11-08T21:28:00.015Z', 26904419))).toBeNull();
    // Without the alignment the same pair differs.
    expect(firstDifference(normalizeForDiff(ts, true), normalizeForDiff(closed('2026-11-08T21:28:00.015Z', 26904420), true))).toBe(
      '$.data.conversation.resolutionSeconds: 26904419 vs 26904420',
    );

    // More than the instants are apart, or the wrong way round, still differs.
    expect(compare(ts, closed('2026-11-08T21:28:00.015Z', 26904421))).toBe('$.data.conversation.resolutionSeconds: 26904419 vs 26904421');
    expect(compare(ts, closed('2026-11-08T21:28:00.015Z', 26904418))).toBe('$.data.conversation.resolutionSeconds: 26904419 vs 26904418');
    // The same instant (stored before the request) compares exactly.
    expect(compare(ts, closed('2026-11-08T21:27:59.990Z', 26904420))).toBe('$.data.conversation.resolutionSeconds: 26904419 vs 26904420');
    // A count against none.
    expect(compare(ts, closed('2026-11-08T21:28:00.015Z', null))).toBe('$.data.conversation.resolutionSeconds: 26904419 vs null');

    // The first response, in an entity event's row as in the answer.
    const replied = (firstResponseAt: string, firstResponseSeconds: number) => ({
      events: [{ entityType: 'desk_conversation', data: { firstResponseAt, firstResponseSeconds, resolvedAt: null, resolutionSeconds: null } }],
    });
    expect(compare(replied('2026-11-08T21:27:59.999Z', 5399), replied('2026-11-08T21:28:00.001Z', 5400))).toBeNull();
    // A seconds field with no instant next to it is not touched.
    expect(compare({ data: { resolutionSeconds: 5 } }, { data: { resolutionSeconds: 6 } })).toBe('$.data.resolutionSeconds: 5 vs 6');
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
