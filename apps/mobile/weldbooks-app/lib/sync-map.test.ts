/**
 * Lockstep checks for weldbooksSyncMap (Phase 8).
 * Run via: pnpm --filter platform exec vitest run ../../mobile/weldbooks-app/lib/sync-map.test.ts
 */
import { describe, expect, it } from 'vitest';
import { booksKeys, weldbooksSyncMap } from './sync-map';
import { BOOKS_HUB_TOPICS } from '../hooks/books-realtime-dispatch';

describe('weldbooksSyncMap', () => {
  it('invoice invalidates invoices + payments + dashboard + reports', () => {
    expect(weldbooksSyncMap.invoice?.invalidate).toEqual([
      booksKeys.invoices(),
      booksKeys.payments(),
      booksKeys.dashboard(),
      booksKeys.reports(),
    ]);
  });

  it('bill invalidates bills + payments + dashboard + documents', () => {
    expect(weldbooksSyncMap.bill?.invalidate).toEqual([
      booksKeys.bills(),
      booksKeys.payments(),
      booksKeys.dashboard(),
      booksKeys.documents(),
    ]);
  });

  it('covers every BOOKS_HUB_TOPICS entry', () => {
    for (const topic of BOOKS_HUB_TOPICS) {
      expect(
        weldbooksSyncMap[topic]?.invalidate?.length,
        `missing sync-map entry for ${topic}`,
      ).toBeGreaterThan(0);
    }
  });
});
