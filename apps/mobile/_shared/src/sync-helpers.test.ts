/**
 * Unit tests for shared mobile-realtime helpers (Phase 8).
 * Run via: pnpm --filter platform exec vitest run ../../mobile/_shared/src/sync-helpers.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { inv } from '@weldsuite/realtime/react';
import { seedSyncMapKeys } from './seed-sync-map-keys';

describe('inv', () => {
  it('builds invalidate-only config', () => {
    expect(inv(['a'], ['b', 'c'])).toEqual({
      invalidate: [['a'], ['b', 'c']],
    });
  });
});

describe('seedSyncMapKeys', () => {
  it('seeds missing prefixes without clobbering existing data', () => {
    const store = new Map<string, unknown>();
    const qc = {
      getQueryData: (key: readonly unknown[]) => store.get(JSON.stringify(key)),
      setQueryData: (key: readonly unknown[], value: unknown) => {
        store.set(JSON.stringify(key), value);
      },
      invalidateQueries: vi.fn(),
      removeQueries: vi.fn(),
    };

    seedSyncMapKeys(qc, {
      invoice: inv(['accounting', 'invoices']),
    });
    expect(store.get(JSON.stringify(['accounting', 'invoices']))).toBeNull();

    store.set(JSON.stringify(['accounting', 'invoices']), { kept: true });
    seedSyncMapKeys(qc, {
      invoice: inv(['accounting', 'invoices']),
    });
    expect(store.get(JSON.stringify(['accounting', 'invoices']))).toEqual({
      kept: true,
    });
  });
});
