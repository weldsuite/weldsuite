import { describe, expect, it } from 'vitest';
import { recordChecksum, stableStringify } from './checksum';

describe('stableStringify', () => {
  it('is insensitive to key order at every depth', () => {
    // Providers do not guarantee key order. Without this, a byte-identical record
    // hashes differently per delivery and every sweep rewrites every row.
    const a = { z: 1, a: { y: 2, b: [{ q: 1, p: 2 }] } };
    const b = { a: { b: [{ p: 2, q: 1 }], y: 2 }, z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('preserves array order', () => {
    // Arrays are ordered data, not a bag of keys — line items on an invoice
    // change meaning if reordered.
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it('drops undefined values but keeps nulls', () => {
    // `null` is a value the provider sent; `undefined` is a key that is not there.
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(stableStringify({ a: 1, b: null })).not.toBe(stableStringify({ a: 1 }));
  });
});

describe('recordChecksum', () => {
  it('is stable across key reordering', async () => {
    const first = await recordChecksum({ id: '1', name: 'Acme', city: 'Utrecht' });
    const second = await recordChecksum({ city: 'Utrecht', name: 'Acme', id: '1' });
    expect(first).toBe(second);
  });

  it('changes when a value changes', async () => {
    const before = await recordChecksum({ id: '1', name: 'Acme' });
    const after = await recordChecksum({ id: '1', name: 'Acme BV' });
    expect(before).not.toBe(after);
  });

  it('ignores the fields a driver declares volatile', async () => {
    // A provider that re-stamps a cursor or `retrieved_at` on every delivery would
    // otherwise defeat the skip path entirely.
    const first = await recordChecksum({ id: '1', name: 'Acme', cursor: 'aaa' }, ['cursor']);
    const second = await recordChecksum({ id: '1', name: 'Acme', cursor: 'bbb' }, ['cursor']);
    expect(first).toBe(second);
  });

  it('still notices a real change when volatile fields are excluded', async () => {
    const first = await recordChecksum({ id: '1', name: 'Acme', cursor: 'aaa' }, ['cursor']);
    const second = await recordChecksum({ id: '1', name: 'Other', cursor: 'aaa' }, ['cursor']);
    expect(first).not.toBe(second);
  });

  it('returns a hex sha-256', async () => {
    expect(await recordChecksum({ id: '1' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
