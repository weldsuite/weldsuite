/**
 * Lockstep checks for weldstashSyncMap (Phase 3).
 * Run via: pnpm --filter platform exec vitest run ../../mobile/weldstash-app/lib/sync-map.test.ts
 */
import { describe, expect, it } from 'vitest';
import { weldstashSyncMap } from './sync-map';
import { weldstashKeys } from './query-client';

describe('weldstashSyncMap', () => {
  it('inventory + adjustment invalidate stock root', () => {
    expect(weldstashSyncMap.inventory?.invalidate).toEqual([['weldstash', 'stock']]);
    expect(weldstashSyncMap.wms_inventory?.invalidate).toEqual([['weldstash', 'stock']]);
    expect(weldstashSyncMap.wms_adjustment?.invalidate).toEqual([['weldstash', 'stock']]);
  });

  it('product aliases invalidate products + stock', () => {
    expect(weldstashSyncMap.product?.invalidate).toEqual([
      weldstashKeys.products(),
      ['weldstash', 'stock'],
    ]);
    expect(weldstashSyncMap.wms_product?.invalidate).toEqual([
      weldstashKeys.products(),
      ['weldstash', 'stock'],
    ]);
  });

  it('picklist + warehouse invalidate list roots + stock', () => {
    expect(weldstashSyncMap.picklist?.invalidate).toEqual([
      weldstashKeys.pickLists(),
      ['weldstash', 'stock'],
    ]);
    expect(weldstashSyncMap.warehouse?.invalidate).toEqual([
      weldstashKeys.warehouses(),
      ['weldstash', 'stock'],
    ]);
  });
});
