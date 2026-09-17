/**
 * Unit tests for Books hub-event → surface dispatch (Phase 3).
 * Run via: pnpm --filter platform exec vitest run ../../mobile/weldbooks-app/hooks/books-realtime-dispatch.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BOOKS_HUB_TOPICS,
  dispatchBooksRealtimeEvent,
  surfacesForBooksTopic,
  type BooksRealtimeSurface,
} from './books-realtime-dispatch';

describe('surfacesForBooksTopic', () => {
  it('maps invoice/bill/payment to list + dashboard surfaces', () => {
    expect(surfacesForBooksTopic('invoice')).toEqual([
      'invoices',
      'dashboard',
      'reports',
    ]);
    expect(surfacesForBooksTopic('bill')).toEqual(['bills', 'dashboard', 'reports']);
    expect(surfacesForBooksTopic('payment')).toEqual([
      'invoices',
      'bills',
      'dashboard',
    ]);
  });

  it('returns empty for unknown topics', () => {
    expect(surfacesForBooksTopic('picklist')).toEqual([]);
    expect(surfacesForBooksTopic('helpdesk')).toEqual([]);
  });
});

describe('dispatchBooksRealtimeEvent', () => {
  it('fires per-surface + any for known topics', () => {
    const seen: BooksRealtimeSurface[] = [];
    dispatchBooksRealtimeEvent('invoice', 'created', {
      onInvalidate: (surface) => seen.push(surface),
    });
    expect(seen).toEqual(['invoices', 'dashboard', 'reports', 'any']);
  });

  it('no-ops when handler missing or topic unknown', () => {
    expect(() =>
      dispatchBooksRealtimeEvent('invoice', 'created', {}),
    ).not.toThrow();
    const onInvalidate = vi.fn();
    dispatchBooksRealtimeEvent('unknown_topic', 'created', { onInvalidate });
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('covers every BOOKS_HUB_TOPICS entry', () => {
    for (const topic of BOOKS_HUB_TOPICS) {
      expect(surfacesForBooksTopic(topic).length).toBeGreaterThan(0);
    }
  });
});
